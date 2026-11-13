/**
 * How long one sign-in waits for the browser to come back, counted from the start of the attempt (T-J03).
 * One constant drives the countdown the settings panel shows, the loopback listener's timeout, and the device-code
 * polling limit of every device flow, so the countdown and the real end of the sign-in cannot drift apart.
 */
export const SIGN_IN_WAIT_MS = 3 * 60_000;
