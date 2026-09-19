import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import {
  Payment,
  Order,
  OrderItem,
  Organization,
} from '../../database/entities';
import {
  formatCurrency,
  formatDateTime,
  formatOptions,
  groupItemsByVatRate,
  isStornoPayment,
  paymentMethodLabel,
  pfandLineAmount,
} from './receipt-pdf.helpers';

/** Width of the printed content column, centered on the A4 page -- mimics a physical thermal receipt rather than a full-width document. */
const CONTENT_WIDTH = 330;

/**
 * Renders a payment's receipt as a PDF — the on-screen/emailable equivalent
 * of the thermal-printer receipt built by OrderPrintService.handlePaymentReceived
 * (see that method for the reference field shapes this mirrors). Exists
 * because until now a receipt only ever existed as a print job sent to a
 * physical printer: no printer configured (or receipt printing left
 * disabled, which it is by default) meant the receipt was unrecoverable —
 * not even an admin could see what a customer was handed, or wasn't.
 */
@Injectable()
export class ReceiptPdfService {
  private readonly logger = new Logger(ReceiptPdfService.name);

  async generateReceiptPdf(
    payment: Payment,
    order: Order,
    organization: Organization | null,
  ): Promise<Buffer> {
    const items = (order.items ?? []) as OrderItem[];
    const qrDataUrl = payment.tseData?.qrCodeData
      ? await this.buildQrDataUrl(payment.tseData.qrCodeData)
      : null;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: `Beleg ${order.orderNumber}`,
          Author: organization?.name || 'OpenEOS',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        const left = (doc.page.width - CONTENT_WIDTH) / 2;
        doc.y = 48;
        if (isStornoPayment(payment))
          this.renderStornoBanner(doc, left, payment);
        this.renderHeader(doc, left, order, organization);
        this.renderItems(doc, left, items);
        this.renderTotals(doc, left, order, payment, items);
        this.renderTse(doc, left, payment, qrDataUrl);
        this.renderFooter(doc, left, organization);
      } catch (err) {
        reject(err as Error);
        return;
      }

      doc.end();
    });
  }

  private async buildQrDataUrl(payload: string): Promise<string> {
    try {
      return await QRCode.toDataURL(payload, { margin: 1, width: 160 });
    } catch (error) {
      this.logger.warn(
        `QR code rendering failed, omitting from receipt: ${(error as Error).message}`,
      );
      return '';
    }
  }

  private divider(doc: PDFKit.PDFDocument, left: number): void {
    doc
      .save()
      .dash(2, { space: 2 })
      .moveTo(left, doc.y)
      .lineTo(left + CONTENT_WIDTH, doc.y)
      .lineWidth(0.75)
      .strokeColor('#a1a1aa')
      .stroke()
      .undash()
      .restore();
    doc.moveDown(0.6);
  }

  private renderStornoBanner(
    doc: PDFKit.PDFDocument,
    left: number,
    payment: Payment,
  ): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#b91c1c')
      .text('STORNO / KORREKTUR', left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#7f1d1d')
      .text(
        `Korrektur zu Zahlung ${payment.reversesPaymentId}`,
        left,
        doc.y + 2,
        { width: CONTENT_WIDTH, align: 'center' },
      );
    doc.moveDown(1);
  }

  private renderHeader(
    doc: PDFKit.PDFDocument,
    left: number,
    order: Order,
    organization: Organization | null,
  ): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111')
      .text(organization?.name || 'Beleg', left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });

    const address = organization?.settings?.address;
    if (address) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555')
        .text(
          `${address.street}, ${address.zip} ${address.city}`,
          left,
          doc.y + 2,
          { width: CONTENT_WIDTH, align: 'center' },
        );
    }
    if (organization?.settings?.taxId) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555')
        .text(`USt-IdNr.: ${organization.settings.taxId}`, left, doc.y + 2, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
    }

    doc.moveDown(0.75);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#111')
      .text(`Beleg ${order.orderNumber}`, left, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555')
      .text(formatDateTime(order.createdAt), left, doc.y + 2, {
        width: CONTENT_WIDTH,
        align: 'center',
      });

    const context: string[] = [];
    if (order.event?.name) context.push(order.event.name);
    if (order.tableNumber) context.push(`Tisch ${order.tableNumber}`);
    if (order.createdByUser)
      context.push(
        `${order.createdByUser.firstName} ${order.createdByUser.lastName}`,
      );
    if (context.length > 0) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#777')
        .text(context.join(' · '), left, doc.y + 2, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
    }

    doc.moveDown(0.75);
    this.divider(doc, left);
  }

  private renderItems(
    doc: PDFKit.PDFDocument,
    left: number,
    items: OrderItem[],
  ): void {
    const qtyColWidth = 24;
    const priceColWidth = 60;
    const nameColWidth = CONTENT_WIDTH - qtyColWidth - priceColWidth;

    for (const item of items) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#111');
      doc.text(String(item.quantity), left, y, { width: qtyColWidth });
      doc.text(item.productName, left + qtyColWidth, y, {
        width: nameColWidth,
      });
      doc.text(
        formatCurrency(item.totalPrice),
        left + qtyColWidth + nameColWidth,
        y,
        { width: priceColWidth, align: 'right' },
      );

      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#999')
        .text(
          `${Number(item.taxRate)}%`,
          left + qtyColWidth + nameColWidth,
          y + 10,
          { width: priceColWidth, align: 'right' },
        );

      const optionLines = formatOptions(item);
      if (optionLines.length > 0) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(7)
          .fillColor('#777')
          .text(optionLines.join(', '), left + qtyColWidth, doc.y, {
            width: nameColWidth,
          });
      }
      if (item.notes) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(7)
          .fillColor('#777')
          .text(item.notes, left + qtyColWidth, doc.y, { width: nameColWidth });
      }

      const pfand = pfandLineAmount(item);
      if (pfand !== null) {
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor('#555')
          .text(`+ Pfand ${formatCurrency(pfand)}`, left + qtyColWidth, doc.y, {
            width: nameColWidth + priceColWidth,
            align: 'right',
          });
      }

      doc.moveDown(0.5);
    }

    doc.moveDown(0.2);
    this.divider(doc, left);
  }

  private renderTotals(
    doc: PDFKit.PDFDocument,
    left: number,
    order: Order,
    payment: Payment,
    items: OrderItem[],
  ): void {
    const labelWidth = CONTENT_WIDTH - 90;

    const row = (label: string, value: string, bold = false) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 10 : 9)
        .fillColor('#111');
      doc.text(label, left, doc.y, { width: labelWidth });
      doc.text(value, left + labelWidth, doc.y - doc.currentLineHeight(), {
        width: 90,
        align: 'right',
      });
      doc.moveDown(0.3);
    };

    row('Zwischensumme', formatCurrency(order.subtotal));

    for (const group of groupItemsByVatRate(items)) {
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor('#777')
        .text(
          `davon ${group.rate}% USt: ${formatCurrency(group.ust)} (netto ${formatCurrency(group.netto)})`,
          left,
          doc.y,
          { width: CONTENT_WIDTH },
        );
      doc.moveDown(0.25);
    }

    if (Number(order.discountAmount) > 0)
      row('Rabatt', `- ${formatCurrency(order.discountAmount)}`);
    if (Number(order.pfandTotal) > 0)
      row('Pfand', formatCurrency(order.pfandTotal));
    row('Gesamt', formatCurrency(order.total), true);
    doc.moveDown(0.3);
    row(
      paymentMethodLabel(payment.paymentMethod),
      formatCurrency(payment.amount),
    );

    doc.moveDown(0.75);
  }

  private renderTse(
    doc: PDFKit.PDFDocument,
    left: number,
    payment: Payment,
    qrDataUrl: string | null,
  ): void {
    const tse = payment.tseData;
    if (!tse) return;

    this.divider(doc, left);

    if (tse.failed) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor('#b91c1c')
        .text(
          'TSE-Signatur nicht verfügbar (Ausfall gemäß BMF-Ausfallregelung).',
          left,
          doc.y,
          { width: CONTENT_WIDTH },
        );
      doc.moveDown(0.75);
      return;
    }

    const textWidth = qrDataUrl ? CONTENT_WIDTH - 120 : CONTENT_WIDTH;
    const startY = doc.y;

    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(`Transaktion: ${tse.transactionNumber}`, left, doc.y, {
      width: textWidth,
    });
    doc.text(`Kassen-Seriennummer: ${tse.serialNumber}`, left, doc.y, {
      width: textWidth,
    });
    doc.text(`Signaturzähler: ${tse.signatureCounter}`, left, doc.y, {
      width: textWidth,
    });
    doc.text(
      `Zeit: ${formatDateTime(tse.startTime)} – ${formatDateTime(tse.endTime)}`,
      left,
      doc.y,
      { width: textWidth },
    );
    doc.text(`Signatur: ${tse.signatureValue.slice(0, 32)}…`, left, doc.y, {
      width: textWidth,
    });

    if (qrDataUrl) {
      const base64 = qrDataUrl.split(',')[1];
      doc.image(Buffer.from(base64, 'base64'), left + textWidth + 10, startY, {
        width: 100,
        height: 100,
      });
    }

    doc.moveDown(1);
  }

  private renderFooter(
    doc: PDFKit.PDFDocument,
    left: number,
    organization: Organization | null,
  ): void {
    const footerText = organization?.settings?.receipt?.footerText;
    if (footerText) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555')
        .text(footerText, left, doc.y, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
      doc.moveDown(0.5);
    }
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#999')
      .text(
        'Dieser Beleg wurde elektronisch erzeugt und dient als Kassenbeleg gemäß § 146a AO.',
        left,
        doc.y,
        { width: CONTENT_WIDTH, align: 'center' },
      );
  }
}
