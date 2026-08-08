#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, canonicalize } from "./waeb-common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsPath = path.resolve(here, "..", "test-vectors", "jcs", "canonicalization.json");
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

for (const vector of vectors.cases) {
  assert(canonicalize(vector.input) === vector.canonical, `JCS vector failed: ${vector.name}`);
}

let rejectedLoneSurrogate = false;
try {
  canonicalize(JSON.parse('{"bad":"\\ud800"}'));
} catch (error) {
  rejectedLoneSurrogate = error instanceof TypeError;
}
assert(rejectedLoneSurrogate, "I-JSON lone surrogate was not rejected");

console.log(JSON.stringify({
  status: "jcs_vectors_valid",
  cases: vectors.cases.length,
  loneSurrogateRejected: true,
}, null, 2));
