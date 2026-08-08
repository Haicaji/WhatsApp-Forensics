import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../dist/collector.iife.js", import.meta.url),
  "utf8"
);

function collection(models) {
  return Object.freeze({
    getModelsArray() {
      return models;
    }
  });
}

function fixtureWindow(supported, poisonSnapshot = false, accountObservable = true) {
  const account = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000001@c.us" }),
    pushname: "Synthetic Account"
  });
  const alternateAccount = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000099@c.us" }),
    pushname: "Alternate Synthetic Account"
  });
  let currentAccount = account;
  const contact = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000002@c.us" }),
    name: "Synthetic Contact",
    isUser: true,
    isWAContact: true
  });
  const messageRecord = {
    id: Object.freeze({ _serialized: "false_100000000000002@c.us_TEST" }),
    chatId: Object.freeze({ _serialized: "100000000000002@c.us" }),
    t: 1_700_000_000,
    type: "chat",
    body: "synthetic message"
  };
  if (poisonSnapshot) {
    Object.defineProperty(messageRecord, "body", {
      get() {
        throw new Error("SECRET-JID-100000000000001@c.us");
      }
    });
  }
  const message = Object.freeze(messageRecord);
  const chat = Object.freeze({
    id: Object.freeze({ _serialized: "100000000000002@c.us" }),
    name: "Synthetic Chat",
    isGroup: false,
    msgs: collection(Object.freeze([message]))
  });
  const contacts = Object.freeze({
    ...collection(Object.freeze([account, contact])),
    getMeContact() {
      return accountObservable ? currentAccount : null;
    }
  });
  const chats = collection(Object.freeze([chat]));
  const moduleCalls = [];
  const page = {
    crypto: webcrypto,
    Debug: Object.freeze({ VERSION: "synthetic-test-build" })
  };
  if (supported) {
    page.require = (name) => {
      moduleCalls.push(name);
      const modules = {
        WAWebContactCollection: Object.freeze({ ContactCollection: contacts }),
        WAWebChatCollection: Object.freeze({ ChatCollection: chats }),
        WAWebUserPrefsMeUser: Object.freeze({ getMaybeMe: () => account })
      };
      if (!Object.hasOwn(modules, name)) {
        throw new Error("unexpected module");
      }
      return modules[name];
    };
  }
  return {
    page,
    moduleCalls,
    switchAccount() {
      currentAccount = alternateAccount;
    }
  };
}

{
  const { page } = fixtureWindow(true, false, false);
  const controller = evaluate(page);
  const probeDispatch = await controller.dispatch("probe");
  assert.equal(probeDispatch.ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  const payload = JSON.parse(probe.payload);
  assert.equal(payload.supported, false);
  assert.equal(payload.adapterId, null);
  assert.equal(payload.accountBindingSha256, null);
  assert.deepEqual(payload.reasons, ["account_reader_signature_mismatch"]);
  assert.equal(payload.capabilities.passiveT0, false);
  assert.equal(payload.capabilities.accounts, false);
  assert.equal(controller.ack(probe.sequence), true);
  const start = await controller.dispatch("start_t0");
  assert.equal(start.ok, false);
  assert.equal(start.code, "unsupported_build");
}

function evaluate(page) {
  return vm.runInNewContext(source, {
    window: page,
    TextEncoder,
    Date,
    Object,
    Array,
    Boolean,
    Error,
    Map,
    Math,
    Number,
    Reflect,
    RegExp,
    Set,
    String,
    Uint8Array
  });
}

function checkFrame(frame) {
  assert.equal(frame.protocol, "wafc-bridge/1");
  assert.match(frame.sequence, /^(0|[1-9][0-9]*)$/);
  assert.equal(frame.encoding, "utf8_json");
  const bytes = new TextEncoder().encode(frame.payload);
  assert.equal(frame.payloadBytes, bytes.byteLength);
  assert.equal(
    frame.payloadSha256,
    createHash("sha256").update(bytes).digest("hex")
  );
  assert.ok(Object.isFrozen(frame));
}

{
  const { page, moduleCalls } = fixtureWindow(true);
  const keysBefore = Object.keys(page).sort();
  const controller = evaluate(page);
  assert.deepEqual(Object.keys(page).sort(), keysBefore);
  assert.ok(Object.isFrozen(controller));
  const unsupportedCommand = await controller.dispatch("anything");
  assert.equal(unsupportedCommand.ok, false);
  assert.equal(unsupportedCommand.code, "unsupported_command");

  const probeDispatch = await controller.dispatch("probe");
  assert.equal(probeDispatch.ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  assert.strictEqual(await controller.next(), probe);
  const probePayload = JSON.parse(probe.payload);
  assert.equal(probePayload.supported, true);
  assert.equal(probePayload.adapterId, "wa-private-collections-v1");
  assert.match(probePayload.accountBindingSha256, /^[0-9a-f]{64}$/);
  assert.equal(probePayload.capabilities.networkActions, false);
  assert.equal(controller.ack("1"), false);
  assert.equal(controller.ack("0"), true);
  assert.equal(controller.ack("0"), true);

  const start = await controller.dispatch("start_t0");
  assert.equal(start.ok, true);
  const frames = [];
  for (;;) {
    const frame = await controller.next();
    if (frame === null) {
      break;
    }
    checkFrame(frame);
    frames.push(frame);
    assert.equal(controller.ack(frame.sequence), true);
    if (frame.kind === "stream_end" || frame.kind === "error") {
      break;
    }
  }
  assert.equal(frames[0].kind, "stream_start");
  assert.equal(frames.at(-1).kind, "stream_end");
  const batches = frames
    .filter((frame) => frame.kind === "records")
    .map((frame) => JSON.parse(frame.payload));
  assert.deepEqual(
    batches.map((batch) => batch.dataset),
    ["accounts", "contacts", "chats", "messages"]
  );
  const streamStart = JSON.parse(frames[0].payload);
  const streamEnd = JSON.parse(frames.at(-1).payload);
  assert.equal(
    batches[0].accountBindingSha256,
    probePayload.accountBindingSha256
  );
  assert.equal(streamStart.accountBindingSha256, probePayload.accountBindingSha256);
  assert.equal(streamEnd.accountBindingSha256, probePayload.accountBindingSha256);
  assert.ok(batches.slice(1).every((batch) => !("accountBindingSha256" in batch)));
  assert.deepEqual(moduleCalls, [
    "WAWebContactCollection",
    "WAWebChatCollection",
    "WAWebUserPrefsMeUser"
  ]);
  assert.equal(await controller.next(), null);
  const finalBindingCheck = await controller.checkAccountBinding();
  assert.equal(finalBindingCheck.ok, true);
  assert.equal(finalBindingCheck.accountBindingSha256, probePayload.accountBindingSha256);
}

{
  const { page, switchAccount } = fixtureWindow(true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch("probe")).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch("start_t0")).ok, true);
  const streamStart = await controller.next();
  assert.equal(streamStart.kind, "stream_start");
  assert.equal(controller.ack(streamStart.sequence), true);
  switchAccount();
  const failure = await controller.next();
  assert.equal(failure.kind, "error");
  assert.equal(JSON.parse(failure.payload).code, "snapshot_failed");
  assert.equal(JSON.parse(failure.payload).message, "snapshot_failed");
  assert.equal(controller.ack(failure.sequence), true);
  const changedBindingCheck = await controller.checkAccountBinding();
  assert.equal(changedBindingCheck.ok, false);
  assert.equal(changedBindingCheck.code, "account_identity_changed");
}

{
  const first = evaluate(fixtureWindow(true).page);
  const second = evaluate(fixtureWindow(true).page);
  assert.equal((await first.dispatch("probe")).ok, true);
  assert.equal((await second.dispatch("probe")).ok, true);
  const firstProbe = await first.next();
  const secondProbe = await second.next();
  const firstBinding = JSON.parse(firstProbe.payload).accountBindingSha256;
  const secondBinding = JSON.parse(secondProbe.payload).accountBindingSha256;
  assert.match(firstBinding, /^[0-9a-f]{64}$/);
  assert.match(secondBinding, /^[0-9a-f]{64}$/);
  assert.notEqual(
    firstBinding,
    secondBinding,
    "per-controller private random secret must prevent cross-run linkability"
  );
  assert.equal(first.ack(firstProbe.sequence), true);
  assert.equal(second.ack(secondProbe.sequence), true);
}

{
  const { page, moduleCalls } = fixtureWindow(false);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch("probe")).ok, true);
  const probe = await controller.next();
  checkFrame(probe);
  assert.equal(JSON.parse(probe.payload).supported, false);
  assert.equal(controller.ack("0"), true);
  const unsupportedBuild = await controller.dispatch("start_t0");
  assert.equal(unsupportedBuild.ok, false);
  assert.equal(unsupportedBuild.code, "unsupported_build");
  assert.deepEqual(moduleCalls, []);
}

{
  const page = {
    crypto: webcrypto,
    Debug: Object.freeze({ VERSION: "synthetic-test-build" }),
    require() {
      throw new Error("SECRET-JID-100000000000001@c.us");
    }
  };
  const controller = evaluate(page);
  assert.equal((await controller.dispatch("probe")).ok, true);
  const probe = await controller.next();
  const payload = JSON.parse(probe.payload);
  assert.equal(payload.supported, false);
  assert.deepEqual(payload.reasons, ["adapter_probe_failed"]);
  assert.equal(probe.payload.includes("SECRET-JID"), false);
}

{
  const { page } = fixtureWindow(true, true);
  const controller = evaluate(page);
  assert.equal((await controller.dispatch("probe")).ok, true);
  const probe = await controller.next();
  assert.equal(controller.ack(probe.sequence), true);
  assert.equal((await controller.dispatch("start_t0")).ok, true);
  let terminal = null;
  for (;;) {
    const frame = await controller.next();
    assert.ok(frame);
    if (frame.kind === "error") {
      terminal = frame;
      break;
    }
    assert.equal(controller.ack(frame.sequence), true);
  }
  assert.deepEqual(JSON.parse(terminal.payload), {
    code: "snapshot_failed",
    message: "snapshot_failed"
  });
  assert.equal(terminal.payload.includes("SECRET-JID"), false);
}

console.log("collector bridge simulation: ok");
