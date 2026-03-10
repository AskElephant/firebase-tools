import { expect } from "chai";

import * as executor from "./executor";

describe("Executor", () => {
  describe("QueueExecutor", () => {
    const exec = new executor.QueueExecutor({
      retries: 20,
      maxBackoff: 1,
      backoff: 1,
    });

    function flushPromises(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it("supports arbitrary return types", async () => {
      await expect(exec.run(() => Promise.resolve(42))).to.eventually.equal(42);
      await expect(exec.run(() => Promise.resolve({ hello: "world" }))).to.eventually.deep.equal({
        hello: "world",
      });
    });

    it("throws errors", async () => {
      const handler = (): Promise<void> => Promise.reject(new Error("Fatal"));
      await expect(exec.run(handler)).to.eventually.be.rejectedWith("Fatal");
    });

    it("retries temporary errors", async () => {
      let throwCount = 0;
      const handler = (): Promise<number> => {
        if (throwCount < 2) {
          throwCount++;
          const err = new Error("Retryable");
          (err as any).code = 429;
          return Promise.reject(err);
        }
        return Promise.resolve(42);
      };

      await expect(exec.run(handler)).to.eventually.equal(42);
    });

    it("eventually gives up on retryable errors", async () => {
      const handler = (): Promise<void> => {
        const err = new Error("Retryable");
        (err as any).code = 429;
        throw err;
      };
      await expect(exec.run(handler)).to.eventually.be.rejectedWith("Retryable");
    });

    it("retries on custom specified retry codes", async () => {
      const handler = (): Promise<void> => {
        const err = new Error("Retryable");
        (err as any).code = 8;
        throw err;
      };
      await expect(
        exec.run(handler, { retryCodes: [...executor.DEFAULT_RETRY_CODES, 8] }),
      ).to.eventually.be.rejectedWith("Retryable");
    });

    it("serializes work in the same keyed queue", async () => {
      const keyedExec = new executor.QueueExecutor({
        retries: 0,
        concurrency: 1,
        maxBackoff: 1,
        backoff: 1,
      });
      let releaseFirst = (): void => undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let secondStarted = false;

      const first = keyedExec.run(
        async () => {
          await firstDone;
        },
        { queueKey: "us-west3" },
      );
      await flushPromises();
      const second = keyedExec.run(
        async () => {
          secondStarted = true;
        },
        { queueKey: "us-west3" },
      );

      await flushPromises();
      expect(secondStarted).to.equal(false);

      releaseFirst();
      await Promise.all([first, second]);
      expect(secondStarted).to.equal(true);
    });

    it("allows different keyed queues to run independently", async () => {
      const keyedExec = new executor.QueueExecutor({
        retries: 0,
        concurrency: 1,
        maxBackoff: 1,
        backoff: 1,
      });
      let active = 0;
      let maxActive = 0;
      let release = (): void => undefined;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });

      const task = async (): Promise<void> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await blocker;
        active -= 1;
      };

      const first = keyedExec.run(task, { queueKey: "us-west3" });
      const second = keyedExec.run(task, { queueKey: "us-central1" });

      await flushPromises();
      expect(maxActive).to.equal(2);

      release();
      await Promise.all([first, second]);
    });

    it("paces starts within a keyed queue", async () => {
      const keyedExec = new executor.QueueExecutor({
        retries: 0,
        concurrency: 3,
        maxBackoff: 1,
        backoff: 1,
        minIntervalMs: 20,
      });
      const starts: number[] = [];

      await Promise.all([
        keyedExec.run(
          async () => {
            starts.push(Date.now());
          },
          { queueKey: "us-west3" },
        ),
        keyedExec.run(
          async () => {
            starts.push(Date.now());
          },
          { queueKey: "us-west3" },
        ),
        keyedExec.run(
          async () => {
            starts.push(Date.now());
          },
          { queueKey: "us-west3" },
        ),
      ]);

      expect(starts[1] - starts[0]).to.be.at.least(15);
      expect(starts[2] - starts[1]).to.be.at.least(15);
    });
  });
});
