import {createHmac, timingSafeEqual} from "node:crypto";

export class PortalTokenService {
  constructor(private readonly publicBaseUrl: string, private readonly secret: string) {}

  url(orderId: string): string {
    return `${this.publicBaseUrl}/recharge/${encodeURIComponent(orderId)}?token=${this.sign(orderId)}`;
  }

  sign(orderId: string): string {
    return createHmac("sha256", this.secret).update(`recharge\0${orderId}`, "utf8").digest("base64url");
  }

  verify(orderId: string, supplied: string): boolean {
    const expected = Buffer.from(this.sign(orderId));
    const received = Buffer.from(supplied);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  paymentToken(orderId: string): string {
    return createHmac("sha256", this.secret).update("payment\0" + orderId).digest("base64url");
  }

  verifyPayment(orderId: string, supplied: string): boolean {
    const expected = Buffer.from(this.paymentToken(orderId));
    const received = Buffer.from(supplied);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
