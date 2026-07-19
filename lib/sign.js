// Ed25519 envelope signing — the oracle leg.
//
// Every published tick is signed over a canonical serialization, so any
// consumer can verify that a price came from this engine and was not altered
// in transit. Key is supplied via env (FAIRLINE_SIGNING_KEY, base64 PKCS8).
// With no key configured the feed still publishes, honestly marked unsigned.

import crypto from "crypto";

let cached = null;

function keys() {
  if (cached) return cached;
  const b64 = process.env.FAIRLINE_SIGNING_KEY;
  if (!b64) return (cached = { privateKey: null, publicKey: null, publicRaw: null });
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return (cached = {
    privateKey,
    publicKey,
    // last 32 bytes of SPKI DER = raw Ed25519 public key
    publicRaw: Buffer.from(spki.subarray(spki.length - 32)).toString("base64"),
  });
}

/** Canonical JSON: recursively sorted object keys, no whitespace. */
export function canonicalize(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Returns the envelope with a `signature` block attached (or signing:off). */
export function signEnvelope(envelope) {
  const { privateKey, publicRaw } = keys();
  if (!privateKey) return { ...envelope, signature: null, signing: "disabled — no FAIRLINE_SIGNING_KEY configured" };
  const message = canonicalize(envelope);
  const sig = crypto.sign(null, Buffer.from(message), privateKey);
  return {
    ...envelope,
    signature: {
      alg: "Ed25519",
      publicKey: publicRaw,
      canonicalization: "recursive-key-sort JSON of the envelope without the `signature` field",
      value: sig.toString("base64"),
    },
  };
}

/** Verify an envelope produced by signEnvelope. Pure — usable by consumers. */
export function verifyEnvelope(signed) {
  if (!signed || !signed.signature || !signed.signature.value) return { valid: false, reason: "unsigned envelope" };
  const { signature, ...envelope } = signed;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        // SPKI prefix for Ed25519
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(signature.publicKey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    const ok = crypto.verify(null, Buffer.from(canonicalize(envelope)), publicKey, Buffer.from(signature.value, "base64"));
    return { valid: ok, reason: ok ? "signature verifies" : "signature mismatch" };
  } catch (e) {
    return { valid: false, reason: "malformed signature: " + e.message };
  }
}

export function publicKeyInfo() {
  const { publicRaw } = keys();
  return {
    alg: "Ed25519",
    publicKey: publicRaw,
    canonicalization: "recursive-key-sort JSON of the envelope without the `signature` field",
    configured: Boolean(publicRaw),
  };
}
