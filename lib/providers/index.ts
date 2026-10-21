import { LogProvider } from "./log";
import { ResendProvider } from "./resend";
import { SesProvider } from "./ses";
import type { EmailProvider } from "./types";

export type ProviderName = "ses" | "resend" | "log";
export type ProviderResolver = (name: ProviderName) => EmailProvider;

/** True only when real sending was explicitly switched on. */
export function sendingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEND_ENABLED === "true";
}

export function chooseProviderName(brandProvider: string | null | undefined, env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (!sendingEnabled(env)) return "log"; // safety switch: nothing leaves the building
  const name = (brandProvider || env.EMAIL_PROVIDER || "log") as ProviderName;
  if (!["ses", "resend", "log"].includes(name)) throw new Error(`unknown provider ${name}`);
  return name;
}

const cache = new Map<ProviderName, EmailProvider>();

export const defaultProviderResolver: ProviderResolver = (name) => {
  let p = cache.get(name);
  if (!p) {
    p = name === "ses" ? new SesProvider() : name === "resend" ? new ResendProvider() : new LogProvider();
    cache.set(name, p);
  }
  return p;
};

export * from "./types";
