/**
 * AI text jobs on a Worker under the desktop app (PLAN-v4 §6b). This Worker holds no provider key and reads
 * no provider file. It sends the job's prompt to the desktop broker, which attaches the job's profile, calls
 * the provider, and returns only the reply text.
 */

/** The one provider a Worker relays for. Every other AI job type is refused before it is leased. */
export type AiProvider = 'lm-studio';

export interface LocalAiReceipt {
  readonly kind: 'text';
  readonly jobId: string;
  readonly provider: AiProvider;
  readonly text: string;
}

/** The desktop broker's completion call, as the Worker client exposes it. */
export type BrokerCompletion = (
  jobId: string,
  leaseToken: string,
  input: {
    readonly messages: readonly unknown[];
    readonly params?: Readonly<Record<string, unknown>>;
  },
) => Promise<string>;

export interface BrokerTextRequest {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly prompt: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly complete: BrokerCompletion;
  readonly progress: (progress: number) => Promise<void>;
}

/**
 * Runs one text job through the desktop broker. The prompt goes out as a single user message. The reply
 * text comes back, and nothing about the profile, the key or the provider endpoint reaches this process.
 */
export async function runBrokerTextJob(options: BrokerTextRequest): Promise<LocalAiReceipt> {
  await options.progress(10);
  const text = await options.complete(options.jobId, options.leaseToken, {
    messages: [{ role: 'user', content: options.prompt }],
    ...(options.params === undefined ? {} : { params: options.params }),
  });
  await options.progress(100);
  return { kind: 'text', jobId: options.jobId, provider: 'lm-studio', text };
}
