// Generates an Ed25519 signing keypair for the feed.
// Prints the private key as an env line (keep secret — goes in Vercel env /
// .env.local, never committed) and the raw public key for reference.
import crypto from "crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const spki = publicKey.export({ format: "der", type: "spki" });
const raw = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");

console.log("FAIRLINE_SIGNING_KEY=" + pkcs8);
console.log("# public key (raw ed25519, base64): " + raw);
