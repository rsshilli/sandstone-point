/**
 * The board's Google Group. Owners' messages are emailed here, and signed-in people get it from
 * /api/me for the "Ask the board" links. It is kept out of the published HTML on purpose.
 */
export const BOARD_EMAIL = 'sandstone-point-hoa@googlegroups.com';

/** An owner's message to the board, ready to send. */
export interface BoardMessage {
  subject: string;
  text: string;
  /** The owner's email, so the board can just press Reply. */
  replyTo: string;
}

/** Sends owners' messages to the board's mailing list. */
export interface BoardMailer {
  send(message: BoardMessage): Promise<void>;
}

/** Where messages come from and go to. */
export interface ResendMailerConfig {
  /** A sender on the HOA's own domain (verified in Resend), e.g. "Sandstone Point website <website@example.org>". */
  from: string;
  /** The board's mailing list. */
  to: string;
  /** Resend API key ("re_…"). */
  apiKey: string;
}

const RESEND_URL = 'https://api.resend.com/emails';
/** Gives up on Resend after this long, well inside the function's own timeout. */
const RESEND_TIMEOUT_MS = 10_000;

/**
 * Sends board messages with Resend (resend.com) from the HOA's domain. Reply-To is the owner,
 * so a board member's reply goes straight to them.
 */
export class ResendBoardMailer implements BoardMailer {
  /**
   * @param config sender, recipient and API key
   * @param fetchFn fetch implementation (injectable for tests)
   */
  constructor(
    private readonly config: ResendMailerConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Sends one message as plain text.
   * @param message the message
   * @throws Error when Resend refuses it or answers without a message id
   */
  async send(message: BoardMessage): Promise<void> {
    const response = await this.fetchFn(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.config.from, to: [this.config.to], reply_to: message.replyTo, subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    // Only a real send carries an id; anything else is a failure even if the status looks fine.
    if (!response.ok || typeof body.id !== 'string') {
      throw new Error(`Resend refused the message: ${response.status} ${body.message ?? ''}`.trim());
    }
  }
}

/**
 * For the local preview: prints each message to the terminal instead of emailing anyone.
 */
export class LogBoardMailer implements BoardMailer {
  /**
   * @param log where to print (console.log by default)
   */
  constructor(private readonly log: (text: string) => void = console.log) {}

  /**
   * Prints the message.
   * @param message the message
   */
  async send(message: BoardMessage): Promise<void> {
    this.log(`\n--- Message to the board (not emailed locally) ---\nReply-To: ${message.replyTo}\nSubject: ${message.subject}\n\n${message.text}\n---\n`);
  }
}
