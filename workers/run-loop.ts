/**
 * Shared worker loop.
 *
 * Each worker is a plain exported function so it can be called by a test, run
 * once by a cron entry, or looped by the scheduler container. Failures are logged
 * and the loop continues: a transient database blip should not take down the
 * process and stop every later pass.
 */

export interface LoopOptions {
  /** Whether the process should keep running. */
  loop: boolean;
  /** Seconds between passes. */
  intervalSeconds: number;
}

export function parseLoopArgs(
  argv: string[] = process.argv.slice(2),
  defaultIntervalSeconds = Number(process.env.WORKER_INTERVAL_SECONDS ?? 60),
): LoopOptions {
  const loopIndex = argv.indexOf('--loop');
  const intervalArg = argv[argv.indexOf('--interval') + 1];

  const intervalSeconds = Number(intervalArg ?? defaultIntervalSeconds) || defaultIntervalSeconds;

  return {
    loop: loopIndex !== -1 || process.env.WORKER_LOOP === 'true',
    intervalSeconds: Math.max(intervalSeconds, 5),
  };
}

/**
 * Runs `task` once, or repeatedly when `--loop` is passed.
 *
 * `close` is called before exit so in-flight database connections are drained
 * rather than abruptly severed.
 */
export function runLoop(
  name: string,
  task: () => Promise<void>,
  close: () => Promise<void>,
  options: LoopOptions = parseLoopArgs(),
): void {
  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;

    console.log(`[${name}] received ${signal}, finishing up`);
    await close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const runPass = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      // One failed pass must not stop the loop; the next pass will retry.
      console.error(`[${name}] pass failed:`, error);
    }
  };

  if (!options.loop) {
    void runPass().then(async () => {
      await close().catch(() => {});
      process.exit(0);
    });
    return;
  }

  void runPass().then(() => {
    const timer = setInterval(() => void runPass(), options.intervalSeconds * 1000);
    // Do not hold the event loop open purely for the timer.
    timer.unref?.();

    console.log(`[${name}] running every ${options.intervalSeconds}s`);
  });
}
