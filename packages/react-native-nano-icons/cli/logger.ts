export type LogLevel = 'normal' | 'verbose';

export type NanoLogger = {
  start: (msg: string) => void;
  update: (msg: string) => void;
  succeed: (msg: string) => void;
  fail: (msg: string) => void;
  /** Only printed when level is 'verbose'. */
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

const PREFIX = 'react-native-nano-icons';

/**
 * Create a spinner-backed logger using yocto-spinner.
 * yocto-spinner and chalk are ESM-only so they are loaded via dynamic import;
 * this factory must be awaited once before use.
 */
export async function createSpinnerLogger(
  level: LogLevel
): Promise<NanoLogger> {
  // Yocto-spinner re-renders each frame on a new line in non-TTY; degrade to quiet logger to avoid flooding CI logs.
  const stream = process.stderr;
  const isInteractive =
    Boolean(stream.isTTY) &&
    process.env['TERM'] !== 'dumb' &&
    !('CI' in process.env);

  if (!isInteractive) return createQuietLogger(level);

  const [{ default: yoctoSpinner }, { default: chalk }] = await Promise.all([
    import('yocto-spinner'),
    import('chalk'),
  ]);

  const prefix = `🔬 ${chalk.dim(PREFIX)} `;
  const spinner = yoctoSpinner({ stream, text: prefix });
  const dimPrefix = chalk.dim(`  ℹ  `);

  return {
    start(msg) {
      spinner.start(prefix + msg);
    },
    update(msg) {
      spinner.text = prefix + msg;
    },
    succeed(msg) {
      if (!spinner.isSpinning) spinner.start(prefix);
      spinner.success(prefix + msg);
    },
    fail(msg) {
      if (!spinner.isSpinning) spinner.start(prefix);
      spinner.error(prefix + chalk.red(msg));
    },
    info(msg) {
      if (level === 'verbose') {
        // Print below the current spinner without disrupting it
        process.stdout.write(`\n${dimPrefix}${chalk.dim(msg)}`);
      }
    },
    warn(msg) {
      if (!spinner.isSpinning) spinner.start(prefix);
      spinner.warning(prefix + chalk.yellow(msg));
    },
  };
}

/**
 * Create a plain-text logger suitable for Expo prebuild context.
 * No spinner — only success/error lines are printed to avoid
 * disrupting Expo's own output.
 */
export async function createQuietLogger(level: LogLevel): Promise<NanoLogger> {
  const { default: chalk } = await import('chalk');
  const dimPrefix = `🔬 ${chalk.dim(PREFIX)}`;
  const tick = chalk.green('✓');
  const cross = chalk.red('✗');
  const info = chalk.blue('ℹ');
  const warning = chalk.yellow('⚠');
  return {
    start(_msg) {
      /* no-op */
    },
    update(_msg) {
      /* no-op */
    },
    succeed(msg) {
      console.log(`${dimPrefix} ${tick} ${msg}`);
    },
    fail(msg) {
      console.error(`${dimPrefix} ${cross} ${msg}`);
    },
    info(msg) {
      if (level === 'verbose') console.log(`${dimPrefix} ${info} ${msg}`);
    },
    warn(msg) {
      console.warn(`${dimPrefix} ${warning} ${msg}`);
    },
  };
}

/**
 * Infer log level from the Expo CLI environment.
 * Expo uses EXPO_DEBUG=1 for verbose/debug output.
 */
export function detectExpoLogLevel(): LogLevel {
  return process.env['EXPO_DEBUG'] ? 'verbose' : 'normal';
}
