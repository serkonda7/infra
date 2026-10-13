import { readFileSync, readdirSync, existsSync } from "node:fs";
import { hostname, homedir, userInfo, arch as osArch } from "node:os";
import type { Facts } from "../types.ts";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export function parseOsRelease(text: string): Facts["os"] {
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  const id = kv.ID ?? "unknown";
  const idLike = (kv.ID_LIKE ?? "").split(/\s+/).filter(Boolean);
  const all = [id, ...idLike];
  const family = all.includes("arch") ? "arch" : all.includes("debian") ? "debian" : "unknown";
  return { family, id, idLike, name: kv.PRETTY_NAME ?? kv.NAME ?? id, version: kv.VERSION_ID ?? "", codename: kv.VERSION_CODENAME ?? "" };
}

const LEVELS: [Facts["cpu"]["level"], string[]][] = [
  ["x86-64-v4", ["avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"]],
  ["x86-64-v3", ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"]],
  ["x86-64-v2", ["cx16", "lahf_lm", "popcnt", "sse4_1", "sse4_2", "ssse3"]],
];

export function parseCpuInfo(text: string, machine: string): Facts["cpu"] {
  const field = (name: string) => text.match(new RegExp(`^${name}\\s*:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  const flags = new Set(field("flags").split(/\s+/));
  let level: Facts["cpu"]["level"] = "unknown";
  if (machine === "x86_64") {
    level = "x86-64";
    // Levels are cumulative: v3 requires v2, v4 requires v3.
    for (const [name, req] of [...LEVELS].reverse()) {
      if (req.every((f) => flags.has(f))) level = name;
      else break;
    }
  }
  return { vendor: field("vendor_id"), model: field("model name"), level };
}

const PCI_VENDORS: Record<string, Facts["gpu"]["vendor"]> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

function gpus(): Facts["gpu"] {
  const all = new Set<Facts["gpu"]["vendor"]>();
  let cards: string[] = [];
  try {
    cards = readdirSync("/sys/class/drm").filter((c) => /^card\d+$/.test(c));
  } catch {}
  for (const c of cards) {
    const v = PCI_VENDORS[read(`/sys/class/drm/${c}/device/vendor`).trim()];
    if (v) all.add(v);
  }
  // Prefer the discrete GPU as "the" vendor.
  const vendor = (["nvidia", "amd", "intel"] as const).find((v) => all.has(v)) ?? "none";
  return { vendor, all: [...all] };
}

function rootfs(): string {
  for (const line of read("/proc/self/mounts").split("\n")) {
    const [, mnt, type] = line.split(" ");
    if (mnt === "/") return type ?? "unknown";
  }
  return "unknown";
}

function users(): Facts["users"] {
  return read("/etc/passwd")
    .split("\n")
    .map((l) => l.split(":"))
    .filter((f) => f.length >= 7 && (Number(f[2]) >= 1000 || Number(f[2]) === 0) && Number(f[2]) < 60000)
    .map((f) => ({ name: f[0]!, uid: Number(f[2]), home: f[5]!, shell: f[6]! }));
}

function bootLoader(): Facts["boot"]["loader"] {
  if (existsSync("/etc/default/limine")) return "limine";
  if (existsSync("/etc/default/grub")) return "grub";
  if (["/boot/loader/loader.conf", "/efi/loader/loader.conf", "/boot/efi/loader/loader.conf"].some(existsSync)) return "systemd-boot";
  return "unknown";
}

const machine = () => ({ x64: "x86_64", arm64: "aarch64" })[osArch() as "x64" | "arm64"] ?? osArch();

/** Gather facts about the local machine. Only reads files — no subprocesses — so it stays fast. */
export function gatherFacts(): Facts {
  const info = userInfo();
  const m = machine();
  return {
    hostname: hostname().split(".")[0]!,
    os: parseOsRelease(read("/etc/os-release") || read("/usr/lib/os-release")),
    arch: m,
    cpu: parseCpuInfo(read("/proc/cpuinfo"), m),
    gpu: gpus(),
    rootfs: rootfs(),
    init: existsSync("/run/systemd/system") ? "systemd" : "unknown",
    user: { name: info.username, uid: info.uid, home: process.env.HOME || homedir() },
    users: users(),
    boot: { loader: bootLoader() },
  };
}

/** `rig facts` output, e.g. saved from another machine. */
export function parseFacts(text: string, source: string): Facts {
  let f: Partial<Facts>;
  try {
    f = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: not JSON (${e instanceof Error ? e.message : e})`);
  }
  if (!f?.hostname || !f.os?.family || !f.user?.home) throw new Error(`${source}: doesn't look like rig facts (create one with \`rig facts\`)`);
  return f as Facts;
}
