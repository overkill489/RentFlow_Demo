import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await deriveKey(password, salt, 64);

  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  try {
    const [salt, storedKey] = storedHash.split(":");

    if (!salt || !storedKey) {
      return false;
    }

    const expected = Buffer.from(storedKey, "hex");

    if (expected.length !== 64) {
      return false;
    }

    const actual = await deriveKey(password, salt, 64);

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
