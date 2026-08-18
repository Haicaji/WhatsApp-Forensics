//! Loopback-only extension pairing and fixed CDP request relay.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use url::Url;

use crate::protocol::{EXTENSION_PROTOCOL, MAX_WIRE_MESSAGE_BYTES, PAIRING_PORT};

type RequestResult = std::result::Result<Value, String>;
type PendingRequests = Arc<Mutex<HashMap<u64, mpsc::SyncSender<RequestResult>>>>;

/// Status messages emitted by the relay thread.
#[derive(Clone, Debug)]
pub enum GatewayEvent {
    Listening,
    Paired {
        browser_family: String,
        browser_version: String,
        extension_version: String,
    },
    Disconnected(String),
    Failed(String),
}

enum HostCommand {
    Cdp {
        request_id: u64,
        method: String,
        params: Value,
    },
    Shutdown,
}

/// Cloneable blocking facade used by the acquisition worker.
#[derive(Clone)]
pub struct GatewayHandle {
    commands: UnboundedSender<HostCommand>,
    pending: PendingRequests,
    request_counter: Arc<AtomicU64>,
    paired: Arc<(Mutex<bool>, Condvar)>,
    stopped: Arc<AtomicBool>,
}

impl GatewayHandle {
    /// Wait until a validated extension hello has been received.
    pub fn wait_paired(&self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let (lock, condition) = &*self.paired;
        let mut paired = lock
            .lock()
            .map_err(|_| anyhow!("pairing state was poisoned"))?;
        while !*paired {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("extension pairing timed out");
            }
            let waited = condition
                .wait_timeout(paired, remaining)
                .map_err(|_| anyhow!("pairing wait was poisoned"))?;
            paired = waited.0;
            if waited.1.timed_out() && !*paired {
                bail!("extension pairing timed out");
            }
        }
        Ok(())
    }

    /// Send one fixed CDP request and block for its correlated result.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        validate_cdp_method(method)?;
        if self.stopped.load(Ordering::SeqCst) {
            bail!("extension relay is stopped");
        }
        let request_id = self.request_counter.fetch_add(1, Ordering::SeqCst);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| anyhow!("pending request state was poisoned"))?
            .insert(request_id, result_tx);
        if self
            .commands
            .send(HostCommand::Cdp {
                request_id,
                method: method.to_owned(),
                params,
            })
            .is_err()
        {
            let _ = self
                .pending
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            bail!("extension relay command channel is closed");
        }
        match result_rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(anyhow!(error)),
            Err(error) => {
                let _ = self
                    .pending
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                Err(anyhow!("CDP request timed out or disconnected: {error}"))
            }
        }
    }

    /// Ask the relay to close the debugger session and listener.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.commands.send(HostCommand::Shutdown);
    }
}

fn validate_cdp_method(method: &str) -> Result<()> {
    anyhow::ensure!(
        matches!(
            method,
            "Runtime.enable"
                | "Runtime.evaluate"
                | "Runtime.callFunctionOn"
                | "Runtime.releaseObject"
        ),
        "CDP method is outside the fixed allowlist"
    );
    Ok(())
}

/// Bind the fixed loopback endpoint and start waiting for the matching pairing code.
pub fn start_gateway(
    pairing_code: String,
) -> Result<(GatewayHandle, mpsc::Receiver<GatewayEvent>)> {
    let (commands_tx, commands_rx) = unbounded_channel();
    let (events_tx, events_rx) = mpsc::channel();
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let paired = Arc::new((Mutex::new(false), Condvar::new()));
    let stopped = Arc::new(AtomicBool::new(false));
    let handle = GatewayHandle {
        commands: commands_tx,
        pending: Arc::clone(&pending),
        request_counter: Arc::new(AtomicU64::new(0)),
        paired: Arc::clone(&paired),
        stopped: Arc::clone(&stopped),
    };
    std::thread::Builder::new()
        .name("field-collector-extension-relay".to_owned())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build();
            let result = match runtime {
                Ok(runtime) => runtime.block_on(run_gateway(
                    pairing_code,
                    commands_rx,
                    events_tx.clone(),
                    pending,
                    paired,
                    stopped,
                )),
                Err(error) => Err(anyhow!("failed to create relay runtime: {error}")),
            };
            if let Err(error) = result {
                let _ = events_tx.send(GatewayEvent::Failed(error.to_string()));
            }
        })
        .context("failed to spawn extension relay")?;
    Ok((handle, events_rx))
}

async fn run_gateway(
    pairing_code: String,
    mut commands: UnboundedReceiver<HostCommand>,
    events: mpsc::Sender<GatewayEvent>,
    pending: PendingRequests,
    paired_state: Arc<(Mutex<bool>, Condvar)>,
    stopped: Arc<AtomicBool>,
) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", PAIRING_PORT))
        .await
        .with_context(|| format!("127.0.0.1:{PAIRING_PORT} is unavailable"))?;
    let _ = events.send(GatewayEvent::Listening);
    let accepted = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .context("extension pairing timed out")??;
    let mut socket = accept_async(accepted.0)
        .await
        .context("extension WebSocket handshake failed")?;
    let hello_message = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .context("extension hello timed out")?
        .ok_or_else(|| anyhow!("extension closed before hello"))??;
    let hello_text = hello_message
        .into_text()
        .context("extension hello was not text")?;
    if hello_text.len() > MAX_WIRE_MESSAGE_BYTES {
        bail!("extension hello exceeded size limit");
    }
    let hello: Value =
        serde_json::from_str(&hello_text).context("extension hello was invalid JSON")?;
    validate_hello(&hello, &pairing_code)?;
    socket
        .send(Message::Text(
            json!({"kind": "paired", "protocol": EXTENSION_PROTOCOL})
                .to_string()
                .into(),
        ))
        .await?;
    set_paired(&paired_state, true)?;
    let _ = events.send(GatewayEvent::Paired {
        browser_family: hello["browserFamily"]
            .as_str()
            .unwrap_or("unknown")
            .to_owned(),
        browser_version: hello["browserVersion"]
            .as_str()
            .unwrap_or("unknown")
            .to_owned(),
        extension_version: hello["extensionVersion"]
            .as_str()
            .unwrap_or("unknown")
            .to_owned(),
    });

    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(HostCommand::Cdp { request_id, method, params }) => {
                        let text = json!({
                            "kind": "cdp_command",
                            "protocol": EXTENSION_PROTOCOL,
                            "requestId": request_id.to_string(),
                            "method": method,
                            "params": params
                        }).to_string();
                        if text.len() > MAX_WIRE_MESSAGE_BYTES {
                            complete_pending(&pending, request_id, Err("host command exceeded size limit".to_owned()));
                            continue;
                        }
                        sink.send(Message::Text(text.into())).await?;
                    }
                    Some(HostCommand::Shutdown) | None => {
                        let _ = sink.send(Message::Text(json!({"kind": "detach", "protocol": EXTENSION_PROTOCOL}).to_string().into())).await;
                        break;
                    }
                }
            }
            message = stream.next() => {
                let Some(message) = message else { break; };
                let message = message?;
                if message.is_close() { break; }
                let Ok(text) = message.into_text() else {
                    bail!("extension sent a non-text frame");
                };
                if text.len() > MAX_WIRE_MESSAGE_BYTES {
                    bail!("extension response exceeded size limit");
                }
                handle_client_response(&pending, &text)?;
            }
        }
    }
    stopped.store(true, Ordering::SeqCst);
    set_paired(&paired_state, false)?;
    fail_all_pending(&pending, "extension disconnected")?;
    let _ = events.send(GatewayEvent::Disconnected("扩展连接已关闭".to_owned()));
    Ok(())
}

fn validate_hello(hello: &Value, pairing_code: &str) -> Result<()> {
    let object = hello
        .as_object()
        .ok_or_else(|| anyhow!("extension hello was not an object"))?;
    let expected = [
        "kind",
        "protocol",
        "pairingCode",
        "url",
        "extensionVersion",
        "browserFamily",
        "browserVersion",
    ];
    anyhow::ensure!(
        object.len() == expected.len(),
        "extension hello fields were invalid"
    );
    anyhow::ensure!(
        expected.iter().all(|key| object.contains_key(*key)),
        "extension hello fields were invalid"
    );
    anyhow::ensure!(hello["kind"] == "hello", "extension hello kind mismatch");
    anyhow::ensure!(
        hello["protocol"] == EXTENSION_PROTOCOL,
        "extension protocol mismatch"
    );
    anyhow::ensure!(
        hello["pairingCode"] == pairing_code,
        "pairing code mismatch"
    );
    let url = Url::parse(hello["url"].as_str().unwrap_or_default())?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str() == Some("web.whatsapp.com")
            && url.port().is_none(),
        "extension was not attached to WhatsApp Web"
    );
    anyhow::ensure!(
        matches!(hello["browserFamily"].as_str(), Some("chrome" | "edge")),
        "unsupported browser"
    );
    Ok(())
}

fn handle_client_response(pending: &PendingRequests, text: &str) -> Result<()> {
    let value: Value = serde_json::from_str(text).context("extension response was invalid JSON")?;
    anyhow::ensure!(
        value["kind"] == "cdp_response",
        "unexpected extension message"
    );
    anyhow::ensure!(
        value["protocol"] == EXTENSION_PROTOCOL,
        "extension protocol mismatch"
    );
    let request_id = value["requestId"]
        .as_str()
        .ok_or_else(|| anyhow!("extension response request id missing"))?
        .parse::<u64>()
        .context("extension response request id invalid")?;
    let result = if value["ok"] == true {
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(value["error"]
            .as_str()
            .unwrap_or("extension command failed")
            .to_owned())
    };
    complete_pending(pending, request_id, result);
    Ok(())
}

fn complete_pending(pending: &PendingRequests, request_id: u64, result: RequestResult) {
    if let Ok(mut requests) = pending.lock()
        && let Some(sender) = requests.remove(&request_id)
    {
        let _ = sender.send(result);
    }
}

fn fail_all_pending(pending: &PendingRequests, reason: &str) -> Result<()> {
    let mut requests = pending
        .lock()
        .map_err(|_| anyhow!("pending request state was poisoned"))?;
    for (_, sender) in requests.drain() {
        let _ = sender.send(Err(reason.to_owned()));
    }
    Ok(())
}

fn set_paired(state: &Arc<(Mutex<bool>, Condvar)>, value: bool) -> Result<()> {
    let (lock, condition) = &**state;
    *lock
        .lock()
        .map_err(|_| anyhow!("pairing state was poisoned"))? = value;
    condition.notify_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{validate_cdp_method, validate_hello};
    use crate::protocol::EXTENSION_PROTOCOL;

    #[test]
    fn hello_requires_whatsapp_and_exact_pairing_code() {
        let hello = json!({
            "kind": "hello",
            "protocol": EXTENSION_PROTOCOL,
            "pairingCode": "23456789AB",
            "url": "https://web.whatsapp.com/",
            "extensionVersion": "0.1.0",
            "browserFamily": "chrome",
            "browserVersion": "140"
        });
        assert!(validate_hello(&hello, "23456789AB").is_ok());
        assert!(validate_hello(&hello, "23456789AC").is_err());
        let mut wrong = hello;
        wrong["url"] = json!("https://example.com/");
        assert!(validate_hello(&wrong, "23456789AB").is_err());
    }

    #[test]
    fn cdp_allowlist_rejects_navigation_and_storage_access() {
        assert!(validate_cdp_method("Runtime.callFunctionOn").is_ok());
        assert!(validate_cdp_method("Page.navigate").is_err());
        assert!(validate_cdp_method("Storage.getStorageKeyForFrame").is_err());
    }
}
