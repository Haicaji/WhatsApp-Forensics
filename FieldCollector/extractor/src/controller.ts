FC.createController = function createController() {
  const state = {
    started: false,
    cancelled: false,
    pending: null,
    pendingAck: null,
    nextSequence: 0,
    finished: false,
    environment: null
  };

  const emit = (kind, payload = {}) => new Promise(resolve => {
    if (state.pending) throw new Error("frame_backpressure_violation");
    const sequence = String(state.nextSequence++);
    state.pending = {protocol: "field-collector-extractor/1", sequence, kind, payload};
    state.pendingAck = resolve;
  });

  const emitDataset = async (dataset, records, chatId = null) => {
    const safeRecords = Array.isArray(records) ? records : [];
    if (safeRecords.length === 0) {
      await emit("dataset_batch", {dataset, chatId, records: [], final: true});
      return;
    }
    const batches = FC.datasetBatches(safeRecords);
    for (let index = 0; index < batches.length; index += 1) {
      await emit("dataset_batch", {
        dataset,
        chatId,
        records: batches[index],
        final: index + 1 === batches.length
      });
    }
  };

  const emitMedia = async (meta, source, options = {}) => {
    await emit("media_start", {
      ...meta,
      source: source.source || "unknown",
      transferMode: source.transferMode || "unknown",
      declaredByteLength: source.byteLength ?? null,
      legacyBuffered: source.legacyBuffered === true
    });
    try {
      const result = await FC.streamMediaSource(
        source,
        chunk => emit("media_chunk", {dataBase64: FC.bytesToBase64(chunk)}),
        () => state.cancelled,
        {
          idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
          deadlineAt: options.deadlineAt ?? 0,
          abortController: options.abortController ?? null
        }
      );
      const status = result.complete ? "available" : "cancelled";
      await emit("media_end", {status, byteLength: result.byteLength});
      return {complete: result.complete, status, error: null};
    } catch (error) {
      const reason = String(error?.message || error);
      await emit("media_end", {status: "failed", reason});
      return {complete: false, status: "failed", error: reason};
    }
  };

  const runFull = async () => {
    const summary = {
      startedAt: new Date().toISOString(), chats: 0, messages: 0,
      originalMedia: 0, previewMedia: 0, failedMedia: 0, incompleteChats: 0
    };
    try {
      const detected = FC.detectModules();
      const env = detected.env;
      FC._activeEnv = env;
      state.environment = env;
      await emit("capabilities", detected.capabilities);
      if (!env.contactCollection || !env.chatCollection || !env.msgGetters) {
        throw new Error("required_whatsapp_models_unavailable");
      }

      const contacts = FC.collectionValues(env.contactCollection);
      let me = null;
      try { me = env.contactCollection.getMeContact?.(); } catch {}
      me ||= contacts.find(contact => Boolean(FC.read(contact, "isMe"))) || null;
      const relevantAvatarIds = new Set();
      const rememberAvatarId = value => {
        const id = FC.idString(value);
        if (id) relevantAvatarIds.add(id);
      };
      rememberAvatarId(FC.first(me, ["id", "wid"]));
      await emitDataset("accounts", me ? [FC.contactRecord(me)] : []);
      await emitDataset("contacts", contacts.map(FC.contactRecord));

      const globals = FC.globalDatasets(env);
      for (const dataset of ["chat_lists", "statuses", "calls", "channels", "channel_events", "communities", "community_relations", "presence_snapshots", "labels", "label_relations"]) {
        await emitDataset(dataset, globals[dataset]);
      }

      const queue = [];
      const byId = new Map();
      FC.absorbChats(queue, byId, env);
      for (let chatIndex = 0; chatIndex < queue.length && !state.cancelled; chatIndex += 1) {
        FC.absorbChats(queue, byId, env);
        const chat = queue[chatIndex];
        const chatId = FC.idString(FC.first(chat, ["id", "wid"]));
        await emit("progress", {phase: "history", chatIndex: chatIndex + 1, chatTotal: queue.length, chatId});
        const synchronized = await FC.syncChatHistory(chat, env, () => state.cancelled);
        const chatRecord = FC.chatRecord(FC.liveChatModels(chat, env).at(-1) || chat);
        await emit("chat_begin", {index: chatIndex + 1, chatId, chat: chatRecord});
        const datasets = FC.chatDerivedDatasets(chat, synchronized.messages, env);
        rememberAvatarId(chatId);
        for (const participant of datasets.participants) rememberAvatarId(participant.id);
        for (const message of datasets.messages) {
          rememberAvatarId(message.senderId);
          rememberAvatarId(message.recipientId);
        }
        for (const dataset of ["participants", "messages", "message_events", "reactions", "receipts", "poll_votes", "group_events", "media_albums", "pins"]) {
          await emitDataset(dataset, datasets[dataset], chatId);
        }
        summary.messages += synchronized.messages.length;
        if (!synchronized.report.complete) summary.incompleteChats += 1;

        let mediaChatRefreshAttempted = false;
        let mediaChatRefreshSucceeded = false;
        for (const message of synchronized.messages) {
          if (state.cancelled || !FC.isMediaMessage(message, env)) continue;
          if (!mediaChatRefreshAttempted && FC.mediaNeedsChatRefresh(message, env)) {
            mediaChatRefreshAttempted = true;
            await emit("progress", {phase: "media_chat_reactivate", chatId});
            try {
              const opened = await FC.openChat(chat, env, {force: true});
              if (opened.opened) {
                await FC.sleep(1_500);
                mediaChatRefreshSucceeded = true;
              }
            } catch {}
          }
          const mediaMessage = mediaChatRefreshSucceeded
            ? FC.refreshedMessageModel(message, chat, env)
            : message;
          const meta = FC.mediaMeta(mediaMessage, env, chatId, "original");
          await emit("progress", {
            phase: "media_request",
            chatId,
            messageId: meta.messageId,
            originalFileName: meta.originalFileName
          });
          let original = null;
          let originalError = null;
          try { original = await FC.originalMedia(mediaMessage, env); }
          catch (error) { originalError = FC.mediaErrorText(error); }
          let originalAttempted = false;
          if (original) {
            originalAttempted = true;
            const result = await emitMedia(meta, original);
            if (result.complete) {
              summary.originalMedia += 1;
              continue;
            }
            originalError = result.error || `original_media_${result.status}`;
            if (state.cancelled) continue;
          }
          let preview = null;
          let previewError = null;
          try { preview = await FC.previewMedia(mediaMessage); }
          catch (error) { previewError = FC.mediaErrorText(error); }
          if (!originalAttempted) {
            await emit("media_failure", {
              ...meta,
              reason: originalError || "original_media_unavailable"
            });
          }
          if (preview) {
            const previewMimeType = preview.mimeType || "application/octet-stream";
            const previewMimeBase = previewMimeType.split(";", 1)[0].trim();
            const previewExtension = FC.mimeExtensions[previewMimeType] || FC.mimeExtensions[previewMimeBase] || ".bin";
            const result = await emitMedia({
              ...meta,
              role: "preview",
              isOriginal: false,
              mimeType: previewMimeType,
              originalFileName: `${meta.type}_${meta.messageId}_preview${previewExtension}`
            }, preview);
            if (result.complete) {
              summary.previewMedia += 1;
              continue;
            }
            previewError = result.error || `preview_media_${result.status}`;
            if (state.cancelled) continue;
          }
          summary.failedMedia += 1;
          if (!preview && previewError) {
            await emit("media_failure", {
              ...meta,
              role: "preview",
              isOriginal: false,
              reason: previewError
            });
          }
        }
        await emit("chat_end", {chatId, history: synchronized.report});
        summary.chats += 1;
        FC.absorbChats(queue, byId, env);
      }

      const avatarTasks = FC.avatarTasks(env, relevantAvatarIds);
      for (let avatarIndex = 0; avatarIndex < avatarTasks.length && !state.cancelled; avatarIndex += 1) {
        const task = avatarTasks[avatarIndex];
        const abortController = new AbortController();
        const startedAt = Date.now();
        const deadlineAt = startedAt + 30_000;
        await emit("progress", {
          phase: "avatar_request",
          avatarIndex: avatarIndex + 1,
          avatarTotal: avatarTasks.length,
          contactId: task.contactId
        });
        try {
          const response = await FC.mediaAwait(
            fetch(task.url, {signal: abortController.signal}),
            15_000,
            "avatar_request_timeout",
            reason => abortController.abort(reason)
          );
          if (!response.ok) throw new Error(`avatar_http_${response.status}`);
          let source = FC.mediaSourceFrom(response, "avatar_response");
          source ||= FC.mediaSourceFrom(await response.blob(), "avatar_blob_fallback");
          if (!source) throw new Error("avatar_response_not_streamable");
          await emitMedia({
            scope: "avatar", contactId: task.contactId, role: "avatar", isOriginal: true,
            mimeType: response.headers.get("content-type") || "image/jpeg",
            originalFileName: `avatar_${task.contactId}.jpg`
          }, source, {
            idleTimeoutMs: 10_000,
            deadlineAt,
            abortController
          });
        } catch (error) {
          if (!state.cancelled) {
            await emit("media_failure", {
              scope: "avatar",
              contactId: task.contactId,
              reason: String(error?.message || error)
            });
          }
        }
      }
      summary.finishedAt = new Date().toISOString();
      summary.status = state.cancelled ? "cancelled" : "complete";
      await emit("complete", summary);
    } catch (error) {
      await emit("error", {message: String(error?.message || error), stack: String(error?.stack || "")});
      summary.finishedAt = new Date().toISOString();
      summary.status = state.cancelled ? "cancelled" : "failed";
      summary.error = String(error?.message || error);
      await emit("complete", summary);
    } finally {
      state.finished = true;
    }
  };

  return {
    async dispatch(command) {
      if (!command || typeof command !== "object") throw new Error("invalid_command");
      if (command.command === "probe") return FC.detectModules().capabilities;
      if (command.command !== "start_full" || state.started) throw new Error("invalid_start_command");
      state.started = true;
      void runFull();
      return {accepted: true};
    },
    next() {
      return state.pending || {protocol: "field-collector-extractor/1", kind: "idle"};
    },
    ack(sequence) {
      if (!state.pending || state.pending.sequence !== String(sequence)) return {accepted: false};
      state.pending = null;
      const resolve = state.pendingAck;
      state.pendingAck = null;
      resolve?.();
      return {accepted: true};
    },
    cancel() {
      state.cancelled = true;
      return {accepted: true};
    }
  };
};
