import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

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
export interface SesMailerConfig {
  /** A sender on the HOA's own domain (verified in SES), e.g. "Sandstone Point website <website@example.org>". */
  from: string;
  /** The board's mailing list. */
  to: string;
  region: string;
}

/**
 * Sends board messages with Amazon SES from the HOA's domain. Reply-To is the owner, so a
 * board member's reply goes straight to them.
 */
export class SesBoardMailer implements BoardMailer {
  private readonly client: Pick<SESv2Client, 'send'>;

  /**
   * @param config sender, recipient and region
   * @param client an SES client (injectable for tests)
   */
  constructor(
    private readonly config: SesMailerConfig,
    client?: Pick<SESv2Client, 'send'>,
  ) {
    this.client = client ?? new SESv2Client({ region: config.region });
  }

  /**
   * Sends one message as plain text.
   * @param message the message
   */
  async send(message: BoardMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.config.from,
        Destination: { ToAddresses: [this.config.to] },
        ReplyToAddresses: [message.replyTo],
        Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text, Charset: 'UTF-8' } } } },
      }),
    );
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
