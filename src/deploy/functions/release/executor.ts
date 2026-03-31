import { Queue } from "../../../throttler/queue";
import { ThrottlerOptions } from "../../../throttler/throttler";
import * as utils from "../../../utils";

/**
 * An Executor runs lambdas (which may be async).
 */
export interface Executor {
  run<T>(func: () => Promise<T>, opts?: RunOptions): Promise<T>;
}

export interface RunOptions {
  retryCodes?: number[];
  queueKey?: string;
}

interface Operation {
  func: () => any;
  retryCodes: number[];
  result?: any;
  error?: any;
}

export interface QueueExecutorOptions extends Omit<ThrottlerOptions<Operation, void>, "handler"> {
  minIntervalMs?: number;
}

export const DEFAULT_RETRY_CODES = [429, 409, 503];

function parseErrorCode(err: any): number {
  return (
    err.status ||
    err.code ||
    err.context?.response?.statusCode ||
    err.original?.status ||
    err.original?.code ||
    err.original?.context?.response?.statusCode
  );
}

async function handler(op: Operation): Promise<void> {
  try {
    op.result = await op.func();
  } catch (err: any) {
    // Throw retry functions back to the queue where they will be retried
    // with backoffs. To do this we cast a wide net for possible error codes.
    // These can be either TOO MANY REQUESTS (429) errors or CONFLICT (409)
    // errors. This can be a raw error with the correct HTTP code, a raw
    // error with the HTTP code stashed where GCP puts it, or a FirebaseError
    // wrapping either of the previous two cases.
    const code = parseErrorCode(err);
    if (op.retryCodes.includes(code)) {
      throw err;
    }
    err.code = code;
    op.error = err;
  }
  return;
}

/**
 * A QueueExecutor implements the executor interface on top of a throttler queue.
 * Any 429 will be retried within the ThrottlerOptions parameters, but all
 * other errors are rethrown.
 */
export class QueueExecutor implements Executor {
  private readonly queues = new Map<string, Queue<Operation, void>>();
  private readonly nextStartTimes = new Map<string, number>();
  private readonly queueReservations = new Map<string, Promise<void>>();

  constructor(private readonly options: QueueExecutorOptions) {}

  private async pace(queueKey: string): Promise<void> {
    const minIntervalMs = this.options.minIntervalMs;
    if (!minIntervalMs) {
      return;
    }

    const previousReservation = this.queueReservations.get(queueKey) || Promise.resolve();
    let releaseReservation = (): void => undefined;
    const currentReservation = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    this.queueReservations.set(
      queueKey,
      previousReservation.then(() => currentReservation),
    );

    await previousReservation;
    try {
      const now = Date.now();
      const nextStartTime = this.nextStartTimes.get(queueKey) || now;
      if (nextStartTime > now) {
        await utils.sleep(nextStartTime - now);
      }
      this.nextStartTimes.set(queueKey, Date.now() + minIntervalMs);
    } finally {
      releaseReservation();
    }
  }

  private getQueue(queueKey?: string): Queue<Operation, void> {
    const key = queueKey || "default";
    let queue = this.queues.get(key);
    if (!queue) {
      const queueName = this.options.name || "queue";
      queue = new Queue({
        ...this.options,
        handler: async (op: Operation) => {
          await this.pace(key);
          await handler(op);
        },
        name: queueKey ? `${queueName}:${queueKey}` : queueName,
      });
      this.queues.set(key, queue);
    }
    return queue;
  }

  async run<T>(func: () => Promise<T>, opts?: RunOptions): Promise<T> {
    const retryCodes = opts?.retryCodes || DEFAULT_RETRY_CODES;

    const op: Operation = {
      func,
      retryCodes,
    };
    await this.getQueue(opts?.queueKey).run(op);
    if (op.error) {
      throw op.error;
    }
    return op.result as T;
  }
}

/**
 * Inline executors run their functions right away.
 * Useful for testing.
 */
export class InlineExecutor {
  run<T>(func: () => Promise<T>): Promise<T> {
    return func();
  }
}
