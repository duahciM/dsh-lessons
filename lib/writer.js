/**
 * 崩溃安全的追加写入器。
 *
 * 设计依据（durability/ 实验实测）：
 *   - 纯内存缓冲 + 进程被杀 → 120/120 全丢
 *   - write() 进内核 + 进程被杀 → 0 丢失
 *   - write() 返回后，数据已在页缓存，进程死亡不影响；只有掉电/内核崩溃才需要 fsync
 *   - fsync 成本：每条 0.966ms（241× write），每 32 条 0.035ms（8.75× write）
 *
 * 因此本写入器：
 *   1. 每条记录立即 write() —— 抗进程被杀（最常见）
 *   2. 累计 fsyncEvery 条或收到 flush 时 fsync() —— 抗掉电
 *   3. flush() 后做回读校验，确认数据真的在盘上
 *   4. 任何异常都不外抛，只降级并记录
 */
import {
  closeSync,
  fsyncSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createDurableWriter(filePath, opts = {}) {
  const fsyncEvery = Number.isSafeInteger(opts.fsyncEvery) && opts.fsyncEvery > 0 ? opts.fsyncEvery : 64;
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};

  let fd = null;
  let unsynced = 0;
  let written = 0;
  let failed = 0;
  let opened = false;

  function open() {
    if (opened) return true;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      // 用 'a+'：追加写 + 可读。纯 'a' 打开的 fd 在多数平台不可 read()，
      // 回读校验会 EBADF（实测 Windows 上必现）。
      fd = openSync(filePath, "a+");
      opened = true;
      return true;
    } catch (e) {
      onError("open", e);
      return false;
    }
  }

  /** 追加一行。立即进内核；按阈值 fsync。永不抛。返回是否成功。 */
  function append(line) {
    if (!open()) {
      failed += 1;
      return false;
    }
    try {
      // writeSync 对常规文件的短写极罕见，但按语义仍需循环
      const buf = Buffer.from(line, "utf8");
      let off = 0;
      while (off < buf.length) {
        const n = writeSync(fd, buf, off, buf.length - off);
        if (n <= 0) throw new Error("write returned 0");
        off += n;
      }
      written += 1;
      unsynced += 1;
      if (unsynced >= fsyncEvery) sync();
      return true;
    } catch (e) {
      failed += 1;
      onError("write", e);
      return false;
    }
  }

  /** fsync 当前文件。永不抛。返回是否成功。 */
  function sync() {
    if (fd === null) return true;
    try {
      fsyncSync(fd);
      unsynced = 0;
      return true;
    } catch (e) {
      onError("fsync", e);
      return false;
    }
  }

  /**
   * 收尾：fsync + 回读校验。
   *
   * 回读读文件尾段，确认期望的最后一行确实在里面。
   * 真正的落盘保证来自 fsync 的返回值；回读只证明「文件内容包含这一行」，
   * 用来抓「write 返回成功但内容没进文件」这类 bug。
   *
   * @param {string} expectedLastLine 期望存在于文件末尾的一行（含或不含换行都可）
   */
  function flushAndVerify(expectedLastLine) {
    const result = { ok: false, size: null, tailChars: 0, error: null };
    try {
      if (fd === null) {
        result.error = "not-open";
        return result;
      }
      const synced = sync();
      const st = fstatSync(fd);
      result.size = st.size;

      if (typeof expectedLastLine !== "string" || expectedLastLine.length === 0) {
        // 没有写入过任何内容时，只剩 fsync 这一项可断言
        result.ok = synced;
        return result;
      }

      // 统一去掉尾部换行再比：我们 append 时带 \n，回读窗口也按内容长度取
      const needle = expectedLastLine.endsWith("\n")
        ? expectedLastLine.slice(0, -1)
        : expectedLastLine;
      const probeLen = Math.min(needle.length, 1024);
      const buf = Buffer.alloc(probeLen);
      const start = Math.max(0, st.size - probeLen);
      const n = readSync(fd, buf, 0, probeLen, start);
      // 我们在 append 时写入了尾随换行，回读窗口会带上它；比较前去掉
      let tail = buf.subarray(0, n).toString("utf8");
      if (tail.endsWith("\n")) tail = tail.slice(0, -1);
      result.tailChars = tail.length;
      // 读到的尾段应是 needle 的一个后缀：needle 以 tail 结尾
      result.ok = synced && tail.length > 0 && needle.endsWith(tail);
      return result;
    } catch (e) {
      result.error = String(e);
      onError("verify", e);
      return result;
    }
  }

  function close() {
    if (fd === null) return;
    try {
      sync();
      closeSync(fd);
    } catch (e) {
      onError("close", e);
    } finally {
      fd = null;
      opened = false;
    }
  }

  return {
    append,
    sync,
    flushAndVerify,
    close,
    stats: () => ({ written, failed, unsynced, fsyncEvery }),
    path: () => filePath,
  };
}
