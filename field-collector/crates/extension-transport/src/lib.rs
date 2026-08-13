//! One-time, loopback-only relay between the portable Collector and its
//! explicitly activated Chromium extension.
//!
//! The relay is intentionally narrow: an extension authenticates with a
//! short-lived high-entropy pairing code, an exact extension/adapter version
//! contract, and an exact `WhatsApp` origin. A second ephemeral listener exposes
//! only the small CDP surface already consumed by `collector-core`; all other
//! commands, files, origins, and network peers fail closed.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use browser_cdp::{BrowserProduct, CdpEndpoint, is_whatsapp_web_url};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, interval_at, timeout},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        http::{HeaderValue, StatusCode},
        protocol::WebSocketConfig,
    },
};

/// Stable extension-to-Collector wire protocol.
pub const PROTOCOL: &str = "wafc-extension-relay/1";
/// Default fixed pairing port hidden behind the ordinary GUI flow.
pub const DEFAULT_PAIRING_PORT: u16 = 17_653;
const SUBPROTOCOL: &str = "wafc-extension-v1";
const PAIR_PATH: &str = "/wafc-extension";
const PAIRING_CODE_LENGTH: usize = 10;
const MAX_WIRE_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_PAIR_ATTEMPTS: usize = 3;
const CHANNEL_CAPACITY: usize = 256;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const MAX_MISSED_HEARTBEATS: u8 = 2;
const HEX: &[u8; 16] = b"0123456789abcdef";

/// Relay setup and protocol errors. Messages never contain page-supplied data.
#[derive(Debug, Error)]
pub enum ExtensionTransportError {
    /// Loopback listener or socket I/O failed.
    #[error("extension relay I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// WebSocket negotiation or framing failed.
    #[error("extension relay WebSocket failed")]
    WebSocket,
    /// Random pairing material could not be generated.
    #[error("extension relay random generation failed")]
    Random,
    /// The extension did not pair before the bounded deadline.
    #[error("extension pairing timed out")]
    PairingTimeout,
    /// Pairing attempts were exhausted or the hello contract was invalid.
    #[error("extension pairing was rejected")]
    PairingRejected,
    /// The extension or host sent a malformed or disallowed protocol message.
    #[error("extension relay protocol violation")]
    Protocol,
    /// The relay background task stopped unexpectedly.
    #[error("extension relay stopped unexpectedly")]
    Stopped,
    /// Fixed pairing port is already in use.
    #[error("extension pairing port is unavailable")]
    PairingPortUnavailable,
}

/// Immutable version/hash policy for one extension pairing session.
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    /// Pairing listener port. Production uses [`DEFAULT_PAIRING_PORT`]; tests
    /// may use `0` to request an ephemeral port.
    pub pairing_port: u16,
    /// Exact release extension version.
    pub extension_version: String,
    /// Exact adapter identifier expected by the Collector release.
    pub adapter_id: String,
    /// `sha256:`-prefixed lowercase adapter digest.
    pub adapter_sha256: String,
    /// Maximum time from listener creation to a valid extension hello.
    pub pairing_timeout: Duration,
}

impl GatewayConfig {
    /// Builds the production pairing policy.
    #[must_use]
    pub fn production(
        extension_version: impl Into<String>,
        adapter_id: impl Into<String>,
        adapter_sha256: impl Into<String>,
    ) -> Self {
        Self {
            pairing_port: DEFAULT_PAIRING_PORT,
            extension_version: extension_version.into(),
            adapter_id: adapter_id.into(),
            adapter_sha256: adapter_sha256.into(),
            pairing_timeout: Duration::from_secs(180),
        }
    }
}

/// Non-content identity observed from the explicitly activated extension tab.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIdentity {
    /// Chrome or Edge reported by the extension shell.
    pub browser_family: BrowserProduct,
    /// Bounded browser version label.
    pub browser_version: String,
    /// Exact extension release version.
    pub extension_version: String,
    /// Exact adapter identifier.
    pub adapter_id: String,
    /// Exact adapter digest.
    pub adapter_sha256: String,
    /// Exact eligible origin URL selected by the operator. Query and fragment
    /// are retained for target locking but never written to handoff summaries.
    pub tab_url: String,
    /// Browser-generated unpacked extension ID observed in the handshake
    /// origin. It is session metadata, not an independent trust anchor.
    pub extension_id: String,
}

/// Ready local CDP facade consumed by the existing acquisition core.
#[derive(Clone, Debug)]
pub struct GatewayReady {
    /// Ephemeral loopback-only HTTP endpoint.
    pub endpoint: CdpEndpoint,
    /// Synthetic target ID bound to the one activated tab.
    pub target_id: String,
    /// Validated non-content extension identity.
    pub identity: ExtensionIdentity,
}

/// Pairing listener shown by the GUI before any evidence writer is created.
pub struct PairingGateway {
    pairing_code: String,
    pairing_port: u16,
    ready: Option<oneshot::Receiver<Result<GatewayReady, ExtensionTransportError>>>,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), ExtensionTransportError>>>,
    cancel_on_drop: bool,
}

/// Active paired relay kept alive for the complete probe/T0/teardown session.
pub struct ActiveGateway {
    ready: GatewayReady,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), ExtensionTransportError>>>,
}

impl PairingGateway {
    /// Binds the loopback pairing listener and generates a one-time code.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid fixed policy, random failure, or an
    /// unavailable pairing port. It never falls back to another production
    /// port because the extension intentionally does not scan localhost.
    pub async fn start(config: GatewayConfig) -> Result<Self, ExtensionTransportError> {
        validate_config(&config)?;
        let listener = TcpListener::bind(("127.0.0.1", config.pairing_port))
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AddrInUse {
                    ExtensionTransportError::PairingPortUnavailable
                } else {
                    ExtensionTransportError::Io(error)
                }
            })?;
        let pairing_port = listener.local_addr()?.port();
        let pairing_code = random_pairing_code()?;
        let (ready_tx, ready_rx) = oneshot::channel();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let task_code = pairing_code.clone();
        let task = tokio::spawn(async move {
            gateway_task(listener, config, task_code, ready_tx, shutdown_rx).await
        });
        Ok(Self {
            pairing_code,
            pairing_port,
            ready: Some(ready_rx),
            shutdown: shutdown_tx,
            task: Some(task),
            cancel_on_drop: true,
        })
    }

    /// Human-entered one-time code. It is never written to logs or evidence.
    #[must_use]
    pub fn pairing_code(&self) -> &str {
        &self.pairing_code
    }

    /// Pairing port used internally by the extension package.
    #[must_use]
    pub const fn pairing_port(&self) -> u16 {
        self.pairing_port
    }

    /// Waits for the exact extension/tab contract, consuming the pairing phase.
    ///
    /// # Errors
    ///
    /// Returns an error on timeout, malformed hello, closed task, or shutdown.
    pub async fn wait_until_ready(mut self) -> Result<ActiveGateway, ExtensionTransportError> {
        let receiver = self.ready.take().ok_or(ExtensionTransportError::Stopped)?;
        let ready = receiver
            .await
            .map_err(|_| ExtensionTransportError::Stopped)??;
        let active = ActiveGateway {
            ready,
            shutdown: self.shutdown.clone(),
            task: self.task.take(),
        };
        self.cancel_on_drop = false;
        Ok(active)
    }
}

impl Drop for PairingGateway {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            let _ = self.shutdown.send(true);
        }
    }
}

impl ActiveGateway {
    /// Ephemeral endpoint and selected target details.
    #[must_use]
    pub const fn ready(&self) -> &GatewayReady {
        &self.ready
    }

    /// Requests relay shutdown and waits for confirmed task termination.
    ///
    /// # Errors
    ///
    /// Returns an error if the background relay panicked or failed teardown.
    pub async fn shutdown(mut self) -> Result<(), ExtensionTransportError> {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.take() {
            return task.await.map_err(|_| ExtensionTransportError::Stopped)?;
        }
        Ok(())
    }
}

impl Drop for ActiveGateway {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ClientMessage {
    Hello {
        protocol: String,
        pairing_code: String,
        extension_version: String,
        adapter_id: String,
        adapter_sha256: String,
        browser_family: BrowserProduct,
        browser_version: String,
        tab_url: String,
    },
    CdpResponse {
        protocol: String,
        request_id: String,
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error_code: Option<String>,
    },
    CdpEvent {
        protocol: String,
        method: String,
        params: Value,
    },
    Detached {
        protocol: String,
        reason: String,
    },
    Heartbeat {
        protocol: String,
        nonce: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ServerMessage {
    Paired {
        protocol: &'static str,
        session_id: String,
    },
    CdpCommand {
        protocol: &'static str,
        request_id: String,
        method: String,
        params: Value,
    },
    Detach {
        protocol: &'static str,
        request_id: String,
    },
    Abort {
        protocol: &'static str,
        reason: &'static str,
    },
    Heartbeat {
        protocol: &'static str,
        nonce: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRequest {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct PendingRequest {
    host_id: u64,
    detach: bool,
}

async fn gateway_task(
    listener: TcpListener,
    config: GatewayConfig,
    pairing_code: String,
    ready_tx: oneshot::Sender<Result<GatewayReady, ExtensionTransportError>>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), ExtensionTransportError> {
    let paired = timeout(
        config.pairing_timeout,
        accept_valid_extension(&listener, &config, &pairing_code, &mut shutdown),
    )
    .await
    .map_err(|_| ExtensionTransportError::PairingTimeout)?;
    let (extension_socket, identity) = match paired {
        Ok(value) => value,
        Err(error) => {
            let _ = ready_tx.send(Err(match error {
                ExtensionTransportError::PairingTimeout => ExtensionTransportError::PairingTimeout,
                _ => ExtensionTransportError::PairingRejected,
            }));
            return Err(error);
        }
    };

    drop(listener);
    let host_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let host_port = host_listener.local_addr()?.port();
    let host_token = random_hex(24)?;
    let target_id = format!("wafc-extension-{}", random_hex(16)?);
    let session_id = format!("wafc-session-{}", random_hex(16)?);
    let endpoint = CdpEndpoint::parse(&format!("http://127.0.0.1:{host_port}"))
        .map_err(|_| ExtensionTransportError::Protocol)?;
    let ready = GatewayReady {
        endpoint,
        target_id: target_id.clone(),
        identity: identity.clone(),
    };

    let (extension_out_tx, extension_out_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let (extension_in_tx, extension_in_rx) = mpsc::channel(CHANNEL_CAPACITY);
    extension_out_tx
        .send(ServerMessage::Paired {
            protocol: PROTOCOL,
            session_id: session_id.clone(),
        })
        .await
        .map_err(|_| ExtensionTransportError::Stopped)?;
    let extension_shutdown = shutdown.clone();
    let extension_task = tokio::spawn(extension_io(
        extension_socket,
        extension_out_rx,
        extension_in_tx,
        extension_shutdown,
    ));

    if ready_tx.send(Ok(ready)).is_err() {
        let _ = extension_out_tx
            .send(ServerMessage::Abort {
                protocol: PROTOCOL,
                reason: "collector_cancelled",
            })
            .await;
        return Err(ExtensionTransportError::Stopped);
    }

    let host_result = serve_host_facade(
        host_listener,
        &host_token,
        &target_id,
        &session_id,
        &identity,
        extension_out_tx.clone(),
        extension_in_rx,
        &mut shutdown,
    )
    .await;
    let _ = extension_out_tx
        .send(ServerMessage::Abort {
            protocol: PROTOCOL,
            reason: "collector_finished",
        })
        .await;
    let extension_result = timeout(IO_TIMEOUT, extension_task)
        .await
        .map_err(|_| ExtensionTransportError::Stopped)?
        .map_err(|_| ExtensionTransportError::Stopped)?;
    host_result?;
    extension_result
}

async fn accept_valid_extension(
    listener: &TcpListener,
    config: &GatewayConfig,
    pairing_code: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(WebSocketStream<TcpStream>, ExtensionIdentity), ExtensionTransportError> {
    for _ in 0..MAX_PAIR_ATTEMPTS {
        let accepted = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Err(ExtensionTransportError::Stopped);
                }
                continue;
            }
            value = listener.accept() => value,
        }?;
        let (stream, peer) = accepted;
        if !peer.ip().is_loopback() {
            continue;
        }
        let extension_id = Arc::new(std::sync::Mutex::new(None::<String>));
        let callback_extension_id = Arc::clone(&extension_id);
        let callback = move |request: &Request, mut response: Response| {
            validate_pairing_request(request, &callback_extension_id)?;
            response.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(SUBPROTOCOL),
            );
            Ok(response)
        };
        let Ok(socket) = accept_hdr_async_with_config(stream, callback, Some(ws_config())).await
        else {
            continue;
        };
        let observed_extension_id = extension_id
            .lock()
            .map_err(|_| ExtensionTransportError::Stopped)?
            .clone()
            .ok_or(ExtensionTransportError::PairingRejected)?;
        if let Ok(value) =
            read_extension_hello(socket, config, pairing_code, observed_extension_id).await
        {
            return Ok(value);
        }
    }
    Err(ExtensionTransportError::PairingRejected)
}

#[allow(clippy::result_large_err)]
fn validate_pairing_request(
    request: &Request,
    extension_id: &Arc<std::sync::Mutex<Option<String>>>,
) -> Result<(), ErrorResponse> {
    if request.uri().path() != PAIR_PATH {
        return Err(http_rejection(StatusCode::NOT_FOUND));
    }
    let offered = request
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|item| item == SUBPROTOCOL)
        });
    if !offered {
        return Err(http_rejection(StatusCode::BAD_REQUEST));
    }
    let Some(origin) = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok())
    else {
        return Err(http_rejection(StatusCode::FORBIDDEN));
    };
    let Some(id) = origin.strip_prefix("chrome-extension://") else {
        return Err(http_rejection(StatusCode::FORBIDDEN));
    };
    if id.len() != 32 || !id.bytes().all(|byte| matches!(byte, b'a'..=b'p')) {
        return Err(http_rejection(StatusCode::FORBIDDEN));
    }
    let mut slot = extension_id
        .lock()
        .map_err(|_| http_rejection(StatusCode::INTERNAL_SERVER_ERROR))?;
    *slot = Some(id.to_owned());
    Ok(())
}

async fn read_extension_hello(
    mut socket: WebSocketStream<TcpStream>,
    config: &GatewayConfig,
    pairing_code: &str,
    extension_id: String,
) -> Result<(WebSocketStream<TcpStream>, ExtensionIdentity), ExtensionTransportError> {
    let message = timeout(IO_TIMEOUT, socket.next())
        .await
        .map_err(|_| ExtensionTransportError::PairingTimeout)?
        .ok_or(ExtensionTransportError::PairingRejected)?
        .map_err(|_| ExtensionTransportError::WebSocket)?;
    let text = message
        .into_text()
        .map_err(|_| ExtensionTransportError::PairingRejected)?;
    if text.len() > MAX_WIRE_MESSAGE_BYTES {
        return Err(ExtensionTransportError::PairingRejected);
    }
    let hello: ClientMessage =
        serde_json::from_str(&text).map_err(|_| ExtensionTransportError::PairingRejected)?;
    let ClientMessage::Hello {
        protocol,
        pairing_code: supplied_code,
        extension_version,
        adapter_id,
        adapter_sha256,
        browser_family,
        browser_version,
        tab_url,
    } = hello
    else {
        return Err(ExtensionTransportError::PairingRejected);
    };
    if protocol != PROTOCOL
        || !pairing_codes_match(&supplied_code, pairing_code)
        || extension_version != config.extension_version
        || adapter_id != config.adapter_id
        || adapter_sha256 != config.adapter_sha256
        || !valid_sha256(&adapter_sha256)
        || !valid_label(&browser_version, 120)
        || !is_whatsapp_web_url(&tab_url)
    {
        return Err(ExtensionTransportError::PairingRejected);
    }
    Ok((
        socket,
        ExtensionIdentity {
            browser_family,
            browser_version,
            extension_version,
            adapter_id,
            adapter_sha256,
            tab_url,
            extension_id,
        },
    ))
}

fn pairing_codes_match(left: &str, right: &str) -> bool {
    left.len() == PAIRING_CODE_LENGTH
        && right.len() == PAIRING_CODE_LENGTH
        && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

async fn extension_io(
    socket: WebSocketStream<TcpStream>,
    mut outbound: mpsc::Receiver<ServerMessage>,
    inbound: mpsc::Sender<ClientMessage>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), ExtensionTransportError> {
    let (mut sink, mut stream) = socket.split();
    let first_heartbeat = Instant::now() + HEARTBEAT_INTERVAL;
    let mut heartbeat = interval_at(first_heartbeat, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut heartbeat_nonce = 0_u64;
    let mut pending_heartbeat = None::<String>;
    let mut missed_heartbeats = 0_u8;
    // A valid CDP response/event proves the same bidirectional loopback relay
    // is alive.  Media streaming can keep Chrome's extension worker busy
    // enough for the dedicated heartbeat echo to be delayed, so liveness must
    // not depend exclusively on that echo while useful protocol traffic is
    // still arriving.
    let mut inbound_activity_since_tick = false;
    let mut heartbeat_enabled = true;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = sink.send(Message::Close(None)).await;
                    return Ok(());
                }
            }
            outgoing = outbound.recv() => {
                let Some(message) = outgoing else {
                    let _ = sink.send(Message::Close(None)).await;
                    return Ok(());
                };
                if matches!(&message, ServerMessage::Detach { .. } | ServerMessage::Abort { .. }) {
                    heartbeat_enabled = false;
                }
                let encoded = serde_json::to_string(&message)
                    .map_err(|_| ExtensionTransportError::Protocol)?;
                if encoded.len() > MAX_WIRE_MESSAGE_BYTES {
                    return Err(ExtensionTransportError::Protocol);
                }
                sink.send(Message::Text(encoded.into()))
                    .await
                    .map_err(|_| ExtensionTransportError::WebSocket)?;
            }
            _ = heartbeat.tick() => {
                if !heartbeat_enabled {
                    continue;
                }
                if heartbeat_still_pending(
                    pending_heartbeat.as_deref(),
                    &mut missed_heartbeats,
                    &mut inbound_activity_since_tick,
                )? {
                    continue;
                }
                let nonce = heartbeat_nonce.to_string();
                heartbeat_nonce = heartbeat_nonce
                    .checked_add(1)
                    .ok_or(ExtensionTransportError::Protocol)?;
                let encoded = serde_json::to_string(&ServerMessage::Heartbeat {
                    protocol: PROTOCOL,
                    nonce: nonce.clone(),
                })
                .map_err(|_| ExtensionTransportError::Protocol)?;
                sink.send(Message::Text(encoded.into()))
                    .await
                    .map_err(|_| ExtensionTransportError::WebSocket)?;
                pending_heartbeat = Some(nonce);
                inbound_activity_since_tick = false;
            }
            incoming = stream.next() => {
                let Some(message) = incoming else {
                    return Err(ExtensionTransportError::Stopped);
                };
                let message = message.map_err(|_| ExtensionTransportError::WebSocket)?;
                match message {
                    Message::Text(text) => {
                        handle_extension_text(
                            &text,
                            &inbound,
                            &mut pending_heartbeat,
                            &mut missed_heartbeats,
                        )
                        .await?;
                        inbound_activity_since_tick = true;
                    }
                    Message::Ping(value) => {
                        sink.send(Message::Pong(value)).await
                            .map_err(|_| ExtensionTransportError::WebSocket)?;
                        inbound_activity_since_tick = true;
                    }
                    Message::Pong(_) => {
                        inbound_activity_since_tick = true;
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Binary(_) | Message::Frame(_) => {
                        return Err(ExtensionTransportError::Protocol);
                    }
                }
            }
        }
    }
}

async fn handle_extension_text(
    text: &str,
    inbound: &mpsc::Sender<ClientMessage>,
    pending_heartbeat: &mut Option<String>,
    missed_heartbeats: &mut u8,
) -> Result<(), ExtensionTransportError> {
    if text.len() > MAX_WIRE_MESSAGE_BYTES {
        return Err(ExtensionTransportError::Protocol);
    }
    let decoded: ClientMessage =
        serde_json::from_str(text).map_err(|_| ExtensionTransportError::Protocol)?;
    match decoded {
        ClientMessage::Heartbeat { protocol, nonce } => {
            if protocol != PROTOCOL || pending_heartbeat.as_deref() != Some(nonce.as_str()) {
                return Err(ExtensionTransportError::Protocol);
            }
            *pending_heartbeat = None;
            *missed_heartbeats = 0;
        }
        ClientMessage::Hello { .. } => return Err(ExtensionTransportError::Protocol),
        message => {
            inbound
                .send(message)
                .await
                .map_err(|_| ExtensionTransportError::Stopped)?;
        }
    }
    Ok(())
}

fn heartbeat_still_pending(
    pending: Option<&str>,
    missed: &mut u8,
    inbound_activity_since_tick: &mut bool,
) -> Result<bool, ExtensionTransportError> {
    if pending.is_none() {
        *inbound_activity_since_tick = false;
        return Ok(false);
    }
    if std::mem::take(inbound_activity_since_tick) {
        *missed = 0;
        return Ok(true);
    }
    *missed = missed
        .checked_add(1)
        .ok_or(ExtensionTransportError::Protocol)?;
    if *missed >= MAX_MISSED_HEARTBEATS {
        return Err(ExtensionTransportError::Stopped);
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
async fn serve_host_facade(
    listener: TcpListener,
    host_token: &str,
    target_id: &str,
    attached_session_id: &str,
    identity: &ExtensionIdentity,
    extension_out: mpsc::Sender<ServerMessage>,
    extension_in: mpsc::Receiver<ClientMessage>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), ExtensionTransportError> {
    let web_socket_path = format!("/devtools/browser/{host_token}");
    loop {
        let (stream, peer) = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
                continue;
            }
            accepted = listener.accept() => accepted?,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        if request_is_websocket(&stream).await? {
            let expected_path = web_socket_path.clone();
            let callback = move |request: &Request, response: Response| {
                if request.uri().path() != expected_path
                    || request.headers().get("Origin").is_some()
                {
                    return Err(http_rejection(StatusCode::FORBIDDEN));
                }
                Ok(response)
            };
            let socket = accept_hdr_async_with_config(stream, callback, Some(ws_config()))
                .await
                .map_err(|_| ExtensionTransportError::WebSocket)?;
            return relay_host_session(
                socket,
                target_id,
                attached_session_id,
                extension_out,
                extension_in,
            )
            .await;
        }
        handle_http_request(
            stream,
            listener.local_addr()?.port(),
            &web_socket_path,
            target_id,
            identity,
        )
        .await?;
    }
}

async fn request_is_websocket(stream: &TcpStream) -> Result<bool, ExtensionTransportError> {
    let mut buffer = vec![0_u8; MAX_HTTP_HEADER_BYTES];
    let size = timeout(IO_TIMEOUT, async {
        loop {
            let size = stream.peek(&mut buffer).await?;
            if size == 0 || find_header_end(&buffer[..size]).is_some() {
                return Ok::<usize, std::io::Error>(size);
            }
            if size == buffer.len() {
                return Ok(size);
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| ExtensionTransportError::Protocol)??;
    let header =
        std::str::from_utf8(&buffer[..size]).map_err(|_| ExtensionTransportError::Protocol)?;
    if find_header_end(header.as_bytes()).is_none() {
        return Err(ExtensionTransportError::Protocol);
    }
    Ok(header.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    }))
}

async fn handle_http_request(
    mut stream: TcpStream,
    port: u16,
    web_socket_path: &str,
    target_id: &str,
    identity: &ExtensionIdentity,
) -> Result<(), ExtensionTransportError> {
    let header = read_http_header(&mut stream).await?;
    let request = std::str::from_utf8(&header).map_err(|_| ExtensionTransportError::Protocol)?;
    let mut lines = request.split("\r\n");
    let request_line = lines.next().ok_or(ExtensionTransportError::Protocol)?;
    let mut parts = request_line.split(' ');
    let method = parts.next();
    let path = parts.next();
    let version = parts.next();
    if parts.next().is_some() || method != Some("GET") || version != Some("HTTP/1.1") {
        return write_http_error(&mut stream, StatusCode::BAD_REQUEST).await;
    }
    let expected_host = format!("127.0.0.1:{port}");
    let hosts: Vec<&str> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim())
        .collect();
    if hosts.as_slice() != [expected_host.as_str()] {
        return write_http_error(&mut stream, StatusCode::BAD_REQUEST).await;
    }
    let web_socket_url = format!("ws://127.0.0.1:{port}{web_socket_path}");
    let body = match path {
        Some("/json/version") => json!({
            "Browser": format!("{} via WAFC extension", identity.browser_version),
            "Protocol-Version": "1.3",
            "webSocketDebuggerUrl": web_socket_url,
        }),
        Some("/json/list") => json!([{
            "id": target_id,
            "type": "page",
            "url": identity.tab_url,
            "title": "WhatsApp Web（已由勘察员选择）",
            "webSocketDebuggerUrl": web_socket_url,
        }]),
        _ => return write_http_error(&mut stream, StatusCode::NOT_FOUND).await,
    };
    let encoded = serde_json::to_vec(&body).map_err(|_| ExtensionTransportError::Protocol)?;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        encoded.len()
    );
    let mut complete = Vec::with_capacity(response.len() + encoded.len());
    complete.extend_from_slice(response.as_bytes());
    complete.extend_from_slice(&encoded);
    stream.write_all(&complete).await?;
    stream.flush().await?;
    drain_http_peer(&mut stream).await;
    stream.shutdown().await?;
    Ok(())
}

async fn read_http_header(stream: &mut TcpStream) -> Result<Vec<u8>, ExtensionTransportError> {
    let mut output = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    timeout(IO_TIMEOUT, async {
        loop {
            let read = stream.read(&mut buffer).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "HTTP header ended early",
                ));
            }
            output.extend_from_slice(&buffer[..read]);
            if output.len() > MAX_HTTP_HEADER_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "HTTP header too large",
                ));
            }
            if let Some(end) = find_header_end(&output) {
                if end != output.len() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "unexpected HTTP body",
                    ));
                }
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| ExtensionTransportError::Protocol)??;
    Ok(output)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

async fn write_http_error(
    stream: &mut TcpStream,
    status: StatusCode,
) -> Result<(), ExtensionTransportError> {
    let reason = status.canonical_reason().unwrap_or("Error");
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        status.as_u16(),
        reason
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    drain_http_peer(stream).await;
    stream.shutdown().await?;
    Ok(())
}

async fn drain_http_peer(stream: &mut TcpStream) {
    let mut byte = [0_u8; 1];
    let _ = timeout(Duration::from_secs(1), stream.read(&mut byte)).await;
}

#[allow(clippy::too_many_lines)]
async fn relay_host_session(
    socket: WebSocketStream<TcpStream>,
    target_id: &str,
    attached_session_id: &str,
    extension_out: mpsc::Sender<ServerMessage>,
    mut extension_in: mpsc::Receiver<ClientMessage>,
) -> Result<(), ExtensionTransportError> {
    let (mut host_sink, mut host_stream) = socket.split();
    let mut attached = false;
    let mut pending = BTreeMap::<String, PendingRequest>::new();
    loop {
        tokio::select! {
            host_message = host_stream.next() => {
                let Some(host_message) = host_message else {
                    break;
                };
                let host_message = host_message.map_err(|_| ExtensionTransportError::WebSocket)?;
                match host_message {
                    Message::Text(text) => {
                        if text.len() > MAX_WIRE_MESSAGE_BYTES {
                            return Err(ExtensionTransportError::Protocol);
                        }
                        let request: HostRequest = serde_json::from_str(&text)
                            .map_err(|_| ExtensionTransportError::Protocol)?;
                        if request.method == "Target.attachToTarget" {
                            validate_attach(&request, target_id, attached)?;
                            attached = true;
                            send_host_result(
                                &mut host_sink,
                                request.id,
                                json!({"sessionId": attached_session_id}),
                            )
                            .await?;
                            continue;
                        }
                        if request.method == "Target.detachFromTarget" {
                            validate_detach(&request, attached_session_id, attached)?;
                            let request_id = request.id.to_string();
                            if pending.insert(request_id.clone(), PendingRequest {
                                host_id: request.id,
                                detach: true,
                            }).is_some() {
                                return Err(ExtensionTransportError::Protocol);
                            }
                            extension_out
                                .send(ServerMessage::Detach {
                                    protocol: PROTOCOL,
                                    request_id,
                                })
                                .await
                                .map_err(|_| ExtensionTransportError::Stopped)?;
                            continue;
                        }
                        validate_forwarded_command(&request, attached_session_id, attached)?;
                        let request_id = request.id.to_string();
                        if pending.insert(request_id.clone(), PendingRequest {
                            host_id: request.id,
                            detach: false,
                        }).is_some() {
                            return Err(ExtensionTransportError::Protocol);
                        }
                        extension_out
                            .send(ServerMessage::CdpCommand {
                                protocol: PROTOCOL,
                                request_id,
                                method: request.method,
                                params: request.params,
                            })
                            .await
                            .map_err(|_| ExtensionTransportError::Stopped)?;
                    }
                    Message::Ping(value) => {
                        host_sink.send(Message::Pong(value)).await
                            .map_err(|_| ExtensionTransportError::WebSocket)?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Binary(_) | Message::Frame(_) => {
                        return Err(ExtensionTransportError::Protocol);
                    }
                }
            }
            extension_message = extension_in.recv() => {
                let Some(extension_message) = extension_message else {
                    return Err(ExtensionTransportError::Stopped);
                };
                match extension_message {
                    ClientMessage::CdpResponse { protocol, request_id, ok, result, error_code } => {
                        if protocol != PROTOCOL {
                            return Err(ExtensionTransportError::Protocol);
                        }
                        let pending_request = pending.remove(&request_id)
                            .ok_or(ExtensionTransportError::Protocol)?;
                        if ok {
                            if error_code.is_some() {
                                return Err(ExtensionTransportError::Protocol);
                            }
                            send_host_result(
                                &mut host_sink,
                                pending_request.host_id,
                                result.unwrap_or_else(|| json!({})),
                            )
                            .await?;
                            if pending_request.detach {
                                attached = false;
                            }
                        } else {
                            if result.is_some() || !valid_extension_error(error_code.as_deref()) {
                                return Err(ExtensionTransportError::Protocol);
                            }
                            send_host_error(&mut host_sink, pending_request.host_id).await?;
                        }
                    }
                    ClientMessage::CdpEvent { protocol, method, params } => {
                        if protocol != PROTOCOL || !attached || !allowed_event(&method) {
                            return Err(ExtensionTransportError::Protocol);
                        }
                        send_host_event(&mut host_sink, attached_session_id, &method, params).await?;
                    }
                    ClientMessage::Detached { protocol, reason } => {
                        if protocol != PROTOCOL || !valid_detach_reason(&reason) {
                            return Err(ExtensionTransportError::Protocol);
                        }
                        if attached {
                            send_host_event(
                                &mut host_sink,
                                attached_session_id,
                                "Inspector.detached",
                                json!({"reason": "extension_debugger_detached"}),
                            )
                            .await?;
                        }
                        break;
                    }
                    ClientMessage::Hello { .. } | ClientMessage::Heartbeat { .. } => {
                        return Err(ExtensionTransportError::Protocol);
                    }
                }
            }
        }
    }
    let _ = extension_out
        .send(ServerMessage::Abort {
            protocol: PROTOCOL,
            reason: "collector_transport_closed",
        })
        .await;
    let _ = host_sink.send(Message::Close(None)).await;
    Ok(())
}

fn validate_attach(
    request: &HostRequest,
    target_id: &str,
    attached: bool,
) -> Result<(), ExtensionTransportError> {
    if attached
        || request.session_id.is_some()
        || request.params.get("targetId").and_then(Value::as_str) != Some(target_id)
        || request.params.get("flatten").and_then(Value::as_bool) != Some(true)
        || request.params.as_object().map(serde_json::Map::len) != Some(2)
    {
        return Err(ExtensionTransportError::Protocol);
    }
    Ok(())
}

fn validate_detach(
    request: &HostRequest,
    attached_session_id: &str,
    attached: bool,
) -> Result<(), ExtensionTransportError> {
    if !attached
        || request.session_id.is_some()
        || request.params.get("sessionId").and_then(Value::as_str) != Some(attached_session_id)
        || request.params.as_object().map(serde_json::Map::len) != Some(1)
    {
        return Err(ExtensionTransportError::Protocol);
    }
    Ok(())
}

fn validate_forwarded_command(
    request: &HostRequest,
    attached_session_id: &str,
    attached: bool,
) -> Result<(), ExtensionTransportError> {
    if !attached || request.session_id.as_deref() != Some(attached_session_id) {
        return Err(ExtensionTransportError::Protocol);
    }
    if !matches!(
        request.method.as_str(),
        "Runtime.enable"
            | "Page.enable"
            | "Page.getFrameTree"
            | "Runtime.evaluate"
            | "Runtime.callFunctionOn"
            | "Runtime.releaseObject"
    ) {
        return Err(ExtensionTransportError::Protocol);
    }
    Ok(())
}

async fn send_host_result<S>(
    sink: &mut S,
    id: u64,
    result: Value,
) -> Result<(), ExtensionTransportError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    send_host_json(sink, json!({"id": id, "result": result})).await
}

async fn send_host_error<S>(sink: &mut S, id: u64) -> Result<(), ExtensionTransportError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    send_host_json(
        sink,
        json!({"id": id, "error": {"code": -32000, "message": "extension command failed closed"}}),
    )
    .await
}

async fn send_host_event<S>(
    sink: &mut S,
    session_id: &str,
    method: &str,
    params: Value,
) -> Result<(), ExtensionTransportError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    send_host_json(
        sink,
        json!({"method": method, "params": params, "sessionId": session_id}),
    )
    .await
}

async fn send_host_json<S>(sink: &mut S, value: Value) -> Result<(), ExtensionTransportError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let encoded = serde_json::to_string(&value).map_err(|_| ExtensionTransportError::Protocol)?;
    if encoded.len() > MAX_WIRE_MESSAGE_BYTES {
        return Err(ExtensionTransportError::Protocol);
    }
    sink.send(Message::Text(encoded.into()))
        .await
        .map_err(|_| ExtensionTransportError::WebSocket)
}

fn allowed_event(method: &str) -> bool {
    matches!(
        method,
        "Page.navigatedWithinDocument"
            | "Page.frameNavigated"
            | "Runtime.executionContextCreated"
            | "Runtime.executionContextsCleared"
            | "Inspector.detached"
            | "Target.targetDestroyed"
            | "Target.detachedFromTarget"
            | "Target.targetInfoChanged"
    )
}

fn valid_extension_error(code: Option<&str>) -> bool {
    matches!(
        code,
        Some(
            "command_rejected"
                | "command_failed"
                | "target_changed"
                | "debugger_detached"
                | "adapter_mismatch"
        )
    )
}

fn valid_detach_reason(value: &str) -> bool {
    matches!(
        value,
        "target_closed" | "canceled_by_user" | "debugger_detached" | "collector_requested"
    )
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_WIRE_MESSAGE_BYTES))
        .max_frame_size(Some(512 * 1024))
        .accept_unmasked_frames(false)
}

fn http_rejection(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some("request rejected".to_owned()));
    *response.status_mut() = status;
    response
}

fn validate_config(config: &GatewayConfig) -> Result<(), ExtensionTransportError> {
    if !valid_label(&config.extension_version, 80)
        || !valid_label(&config.adapter_id, 120)
        || !valid_sha256(&config.adapter_sha256)
        || config.pairing_timeout < Duration::from_secs(10)
        || config.pairing_timeout > Duration::from_secs(600)
    {
        return Err(ExtensionTransportError::Protocol);
    }
    Ok(())
}

fn valid_label(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.is_ascii()
        && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn random_pairing_code() -> Result<String, ExtensionTransportError> {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let mut random = [0_u8; PAIRING_CODE_LENGTH];
    getrandom::fill(&mut random).map_err(|_| ExtensionTransportError::Random)?;
    Ok(random
        .iter()
        .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
        .collect())
}

fn random_hex(bytes: usize) -> Result<String, ExtensionTransportError> {
    let mut random = vec![0_u8; bytes];
    getrandom::fill(&mut random).map_err(|_| ExtensionTransportError::Random)?;
    let mut output = String::with_capacity(bytes * 2);
    for byte in random {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use browser_cdp::{CdpSession, get_version, list_whatsapp_targets};
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    #[test]
    fn pairing_code_is_human_safe_and_high_entropy() {
        let code = random_pairing_code().unwrap_or_else(|error| panic!("pairing code: {error}"));
        assert_eq!(code.len(), PAIRING_CODE_LENGTH);
        assert!(
            code.bytes()
                .all(|byte| b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&byte))
        );
        assert!(!code.contains('0'));
        assert!(!code.contains('O'));
        assert!(!code.contains('I'));
        assert!(!code.contains('1'));
    }

    #[test]
    fn version_hash_and_command_boundaries_are_fixed() {
        assert_eq!(HEARTBEAT_INTERVAL, Duration::from_secs(15));
        assert_eq!(MAX_MISSED_HEARTBEATS, 2);
        let pending = Some("0");
        let mut missed = 0;
        let mut inbound_activity = false;
        assert!(matches!(
            heartbeat_still_pending(pending, &mut missed, &mut inbound_activity),
            Ok(true)
        ));
        assert_eq!(missed, 1);
        assert!(matches!(
            heartbeat_still_pending(pending, &mut missed, &mut inbound_activity),
            Err(ExtensionTransportError::Stopped)
        ));

        let mut missed_during_media = 1;
        let mut media_response_arrived = true;
        assert!(matches!(
            heartbeat_still_pending(
                pending,
                &mut missed_during_media,
                &mut media_response_arrived,
            ),
            Ok(true)
        ));
        assert_eq!(missed_during_media, 0);
        assert!(!media_response_arrived);

        // A long media stream may span many heartbeat intervals.  Every
        // validated CDP response is liveness, so the relay stays open without
        // weakening the two-quiet-interval failure boundary.
        for _ in 0..20 {
            media_response_arrived = true;
            assert!(matches!(
                heartbeat_still_pending(
                    pending,
                    &mut missed_during_media,
                    &mut media_response_arrived,
                ),
                Ok(true)
            ));
            assert_eq!(missed_during_media, 0);
        }
        assert!(matches!(
            heartbeat_still_pending(
                pending,
                &mut missed_during_media,
                &mut media_response_arrived,
            ),
            Ok(true)
        ));
        assert_eq!(missed_during_media, 1);
        assert!(matches!(
            heartbeat_still_pending(
                pending,
                &mut missed_during_media,
                &mut media_response_arrived,
            ),
            Err(ExtensionTransportError::Stopped)
        ));
        assert!(valid_sha256(&format!("sha256:{}", "a".repeat(64))));
        assert!(!valid_sha256(&format!("sha256:{}", "A".repeat(64))));
        for allowed in [
            "Page.navigatedWithinDocument",
            "Page.frameNavigated",
            "Runtime.executionContextCreated",
            "Runtime.executionContextsCleared",
            "Inspector.detached",
            "Target.targetDestroyed",
            "Target.detachedFromTarget",
            "Target.targetInfoChanged",
        ] {
            assert!(allowed_event(allowed));
        }
        assert!(!allowed_event("Network.requestWillBeSent"));
        assert!(!allowed_event("Runtime.consoleAPICalled"));
        let disallowed = HostRequest {
            id: 1,
            method: "Network.enable".to_owned(),
            params: json!({}),
            session_id: Some("attached".to_owned()),
        };
        assert!(validate_forwarded_command(&disallowed, "attached", true).is_err());
    }

    #[tokio::test]
    async fn paired_extension_exposes_only_the_existing_cdp_core_contract() {
        let adapter_sha256 = format!("sha256:{}", "a".repeat(64));
        let gateway = PairingGateway::start(GatewayConfig {
            pairing_port: 0,
            extension_version: "0.1.0".to_owned(),
            adapter_id: "wa-private-collections-v1".to_owned(),
            adapter_sha256: adapter_sha256.clone(),
            pairing_timeout: Duration::from_secs(10),
        })
        .await
        .unwrap_or_else(|error| panic!("start gateway: {error}"));
        let pairing_code = gateway.pairing_code().to_owned();
        let pairing_port = gateway.pairing_port();
        let fake_extension = tokio::spawn(async move {
            run_fake_extension(pairing_port, &pairing_code, &adapter_sha256).await
        });

        let active = gateway
            .wait_until_ready()
            .await
            .unwrap_or_else(|error| panic!("pair extension: {error}"));
        let ready = active.ready().clone();
        let version = get_version(&ready.endpoint)
            .await
            .unwrap_or_else(|error| panic!("facade version: {error}"));
        let targets = list_whatsapp_targets(&ready.endpoint)
            .await
            .unwrap_or_else(|error| panic!("facade targets: {error}"));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, ready.target_id);
        let session = CdpSession::connect(&ready.endpoint, &version.web_socket_debugger_url)
            .await
            .unwrap_or_else(|error| panic!("facade WebSocket: {error}"));
        let attached = session
            .attach_to_target(&ready.target_id)
            .await
            .unwrap_or_else(|error| panic!("attach facade target: {error}"));
        let result = session
            .request("Runtime.enable", json!({}), Some(&attached))
            .await
            .unwrap_or_else(|error| panic!("forward Runtime.enable: {error}"));
        assert_eq!(result, json!({}));
        session
            .detach_from_target(&attached)
            .await
            .unwrap_or_else(|error| panic!("detach facade target: {error}"));
        session
            .close()
            .await
            .unwrap_or_else(|error| panic!("close facade: {error}"));
        active
            .shutdown()
            .await
            .unwrap_or_else(|error| panic!("shutdown gateway: {error}"));
        fake_extension
            .await
            .unwrap_or_else(|error| panic!("join fake extension: {error}"))
            .unwrap_or_else(|error| panic!("fake extension: {error}"));
    }

    async fn run_fake_extension(
        port: u16,
        pairing_code: &str,
        adapter_sha256: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("ws://127.0.0.1:{port}{PAIR_PATH}");
        let mut request = url.into_client_request()?;
        request.headers_mut().insert(
            "Origin",
            HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        let (mut socket, _) = connect_async(request).await?;
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "kind": "hello",
                    "protocol": PROTOCOL,
                    "pairing_code": pairing_code,
                    "extension_version": "0.1.0",
                    "adapter_id": "wa-private-collections-v1",
                    "adapter_sha256": adapter_sha256,
                    "browser_family": "chrome",
                    "browser_version": "Chrome/151.0.0.0",
                    "tab_url": "https://web.whatsapp.com/",
                }))?
                .into(),
            ))
            .await?;
        loop {
            let Some(message) = socket.next().await else {
                return Ok(());
            };
            let message = message?;
            match message {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text)?;
                    match value.get("kind").and_then(Value::as_str) {
                        Some("paired") => {}
                        Some("heartbeat") => {
                            echo_fake_heartbeat(&mut socket, &value).await?;
                        }
                        Some("cdp_command") => {
                            let request_id = value
                                .get("request_id")
                                .and_then(Value::as_str)
                                .ok_or("missing relay request ID")?;
                            socket
                                .send(Message::Text(
                                    serde_json::to_string(&json!({
                                        "kind": "cdp_response",
                                        "protocol": PROTOCOL,
                                        "request_id": request_id,
                                        "ok": true,
                                        "result": {},
                                    }))?
                                    .into(),
                                ))
                                .await?;
                        }
                        Some("detach") => {
                            let request_id = value
                                .get("request_id")
                                .and_then(Value::as_str)
                                .ok_or("missing detach request ID")?;
                            socket
                                .send(Message::Text(
                                    serde_json::to_string(&json!({
                                        "kind": "cdp_response",
                                        "protocol": PROTOCOL,
                                        "request_id": request_id,
                                        "ok": true,
                                        "result": {},
                                    }))?
                                    .into(),
                                ))
                                .await?;
                        }
                        Some("abort") => {
                            socket.close(None).await?;
                            return Ok(());
                        }
                        _ => return Err("unexpected server message".into()),
                    }
                }
                Message::Ping(value) => socket.send(Message::Pong(value)).await?,
                Message::Pong(_) => {}
                Message::Close(_) => return Ok(()),
                Message::Binary(_) | Message::Frame(_) => {
                    return Err("unexpected binary frame".into());
                }
            }
        }
    }

    async fn echo_fake_heartbeat<S>(
        socket: &mut WebSocketStream<S>,
        value: &Value,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let nonce = value
            .get("nonce")
            .and_then(Value::as_str)
            .ok_or("missing heartbeat nonce")?;
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "kind": "heartbeat",
                    "protocol": PROTOCOL,
                    "nonce": nonce,
                }))?
                .into(),
            ))
            .await?;
        Ok(())
    }
}
