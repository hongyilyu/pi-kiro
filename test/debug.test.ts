import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/debug";

describe("log levels", () => {
  const originalLevel = process.env.KIRO_LOG;
  const originalFile = process.env.KIRO_LOG_FILE;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalLevel === undefined) delete process.env.KIRO_LOG;
    else process.env.KIRO_LOG = originalLevel;
    if (originalFile === undefined) delete process.env.KIRO_LOG_FILE;
    else process.env.KIRO_LOG_FILE = originalFile;
  });

  it("default (warn) logs error and warn but not info/debug", () => {
    delete process.env.KIRO_LOG;
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("KIRO_LOG=debug enables all levels", () => {
    process.env.KIRO_LOG = "debug";
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("KIRO_LOG=error suppresses warn/info/debug", () => {
    process.env.KIRO_LOG = "error";
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("isDebug() reflects current threshold", () => {
    delete process.env.KIRO_LOG;
    expect(log.isDebug()).toBe(false);
    process.env.KIRO_LOG = "debug";
    expect(log.isDebug()).toBe(true);
  });

  it("invalid KIRO_LOG falls back to warn default", () => {
    process.env.KIRO_LOG = "shouty";
    log.warn("w");
    log.info("i");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("KIRO_LOG_FILE redirection", () => {
  const originalLevel = process.env.KIRO_LOG;
  const originalFile = process.env.KIRO_LOG_FILE;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let tmp: string;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    tmp = mkdtempSync(join(tmpdir(), "pi-kiro-log-"));
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    if (originalLevel === undefined) delete process.env.KIRO_LOG;
    else process.env.KIRO_LOG = originalLevel;
    if (originalFile === undefined) delete process.env.KIRO_LOG_FILE;
    else process.env.KIRO_LOG_FILE = originalFile;
  });

  it("writes JSON lines to file and skips console when KIRO_LOG_FILE is set", () => {
    const file = join(tmp, "out.log");
    process.env.KIRO_LOG = "debug";
    process.env.KIRO_LOG_FILE = file;

    log.error("boom", { code: 1 });
    log.debug("step", { n: 2 });

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.level).toBe("error");
    expect(first.msg).toBe("boom");
    expect(first.data).toEqual({ code: 1 });
    expect(typeof first.ts).toBe("string");
    const second = JSON.parse(lines[1]!);
    expect(second.level).toBe("debug");
    expect(second.data).toEqual({ n: 2 });
  });

  it("creates parent directories as needed", () => {
    const file = join(tmp, "nested", "deep", "trace.log");
    process.env.KIRO_LOG = "info";
    process.env.KIRO_LOG_FILE = file;

    log.info("hi");

    const contents = readFileSync(file, "utf8").trim();
    expect(JSON.parse(contents).msg).toBe("hi");
  });

  it("respects level threshold when file is configured", () => {
    const file = join(tmp, "level.log");
    process.env.KIRO_LOG = "warn";
    process.env.KIRO_LOG_FILE = file;

    log.debug("should be dropped");
    log.info("also dropped");
    log.warn("kept");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe("kept");
  });

  it("handles records with no data payload", () => {
    const file = join(tmp, "plain.log");
    process.env.KIRO_LOG = "debug";
    process.env.KIRO_LOG_FILE = file;

    log.info("ping");

    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.msg).toBe("ping");
    expect(record.data).toBeUndefined();
  });
});
