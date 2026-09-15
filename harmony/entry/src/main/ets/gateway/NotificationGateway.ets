/** Placeholder until Task 14 wires real notifications. Signature is final. */
export class NotificationGateway {
  static readonly instance: NotificationGateway = new NotificationGateway();

  async notifyReply(title: string, body: string): Promise<void> {
    console.info(`[cc-pet] would notify: ${title} / ${body}`);
  }
}
