import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { Payment, Order, OrderItem, Organization } from '../../database/entities';

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

  async generateReceiptPdf(payment: Payment, order: Order, organization: Organization | null): Promise<Buffer> {
    const items = (order.items ?? []) as OrderItem[];
    const qrDataUrl = payment.tseData?.qrCodeData
      ? await this.buildQrDataUrl(payment.tseData.qrCodeData)
      : null;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: { Title: `Beleg ${order.orderNumber}`, Author: organization?.name || 'OpenEOS' },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        this.renderHeader(doc, order, organization);
        this.renderItems(doc, items);
        this.renderTotals(doc, order, payment);
        this.renderTse(doc, payment, qrDataUrl);
        this.renderFooter(doc, organization);
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
      this.logger.warn(`QR code rendering failed, omitting from receipt: ${(error as Error).message}`);
      return '';
    }
  }

  private renderHeader(doc: PDFKit.PDFDocument, order: Order, organization: Organization | null): void {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111')
      .text(organization?.name || 'Beleg', left, doc.y, { width });

    const address = organization?.settings?.address;
    if (address) {
      doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(`${address.street}, ${address.zip} ${address.city}`, left, doc.y + 2, { width });
    }
    if (organization?.settings?.taxId) {
      doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(`USt-IdNr.: ${organization.settings.taxId}`, left, doc.y + 2, { width });
    }

    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111')
      .text(`Beleg ${order.orderNumber}`, left, doc.y, { width });
    doc.font('Helvetica').fontSize(9).fillColor('#555')
      .text(this.formatDateTime(order.createdAt), left, doc.y + 2, { width });

    doc.moveDown(1);
    doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y)
      .lineWidth(0.5).strokeColor('#d4d4d8').stroke().restore();
    doc.moveDown(0.75);
  }

  private renderItems(doc: PDFKit.PDFDocument, items: OrderItem[]): void {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const qtyColWidth = 30;
    const priceColWidth = 70;
    const nameColWidth = width - qtyColWidth - priceColWidth;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555');
    doc.text('Menge', left, doc.y, { width: qtyColWidth });
    doc.text('Artikel', left + qtyColWidth, doc.y - doc.currentLineHeight(), { width: nameColWidth });
    doc.text('Preis', left + qtyColWidth + nameColWidth, doc.y - doc.currentLineHeight(), { width: priceColWidth, align: 'right' });
    doc.moveDown(0.5);

    for (const item of items) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor('#111');
      doc.text(String(item.quantity), left, y, { width: qtyColWidth });
      doc.text(item.productName, left + qtyColWidth, y, { width: nameColWidth });
      doc.text(this.formatCurrency(item.totalPrice), left + qtyColWidth + nameColWidth, y, { width: priceColWidth, align: 'right' });

      const optionLines = this.formatOptions(item);
      if (optionLines.length > 0) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#777')
          .text(optionLines.join(', '), left + qtyColWidth, doc.y, { width: nameColWidth });
      }
      if (item.notes) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#777')
          .text(item.notes, left + qtyColWidth, doc.y, { width: nameColWidth });
      }
      doc.moveDown(0.4);
    }

    doc.moveDown(0.5);
    doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y)
      .lineWidth(0.5).strokeColor('#d4d4d8').stroke().restore();
    doc.moveDown(0.75);
  }

  private renderTotals(doc: PDFKit.PDFDocument, order: Order, payment: Payment): void {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const labelWidth = width - 100;

    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#111');
      doc.text(label, left, doc.y, { width: labelWidth });
      doc.text(value, left + labelWidth, doc.y - doc.currentLineHeight(), { width: 100, align: 'right' });
      doc.moveDown(0.3);
    };

    row('Zwischensumme', this.formatCurrency(order.subtotal));
    if (Number(order.discountAmount) > 0) {
      row('Rabatt', `- ${this.formatCurrency(order.discountAmount)}`);
    }
    if (Number(order.pfandTotal) > 0) {
      row('Pfand', this.formatCurrency(order.pfandTotal));
    }
    if (Number(order.taxTotal) > 0) {
      row('MwSt.', this.formatCurrency(order.taxTotal));
    }
    row('Gesamt', this.formatCurrency(order.total), true);
    doc.moveDown(0.3);
    row(this.paymentMethodLabel(payment.paymentMethod), this.formatCurrency(payment.amount));

    doc.moveDown(1);
  }

  private renderTse(doc: PDFKit.PDFDocument, payment: Payment, qrDataUrl: string | null): void {
    const tse = payment.tseData;
    if (!tse) return;

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y)
      .lineWidth(0.5).strokeColor('#d4d4d8').stroke().restore();
    doc.moveDown(0.75);

    if (tse.failed) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#b91c1c')
        .text('TSE-Signatur nicht verfügbar (Ausfall gemäß BMF-Ausfallregelung).', left, doc.y, { width });
      doc.moveDown(0.75);
      return;
    }

    const textWidth = qrDataUrl ? width - 130 : width;
    const startY = doc.y;

    doc.font('Helvetica').fontSize(8).fillColor('#555');
    doc.text(`Transaktion: ${tse.transactionNumber}`, left, doc.y, { width: textWidth });
    doc.text(`Kassen-Seriennummer: ${tse.serialNumber}`, left, doc.y, { width: textWidth });
    doc.text(`Signaturzähler: ${tse.signatureCounter}`, left, doc.y, { width: textWidth });
    doc.text(`Zeit: ${this.formatDateTime(tse.startTime)} – ${this.formatDateTime(tse.endTime)}`, left, doc.y, { width: textWidth });
    doc.text(`Signatur: ${tse.signatureValue.slice(0, 40)}…`, left, doc.y, { width: textWidth });

    if (qrDataUrl) {
      const base64 = qrDataUrl.split(',')[1];
      doc.image(Buffer.from(base64, 'base64'), left + textWidth + 10, startY, { width: 110, height: 110 });
    }

    doc.moveDown(1);
  }

  private renderFooter(doc: PDFKit.PDFDocument, organization: Organization | null): void {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const footerText = organization?.settings?.receipt?.footerText;
    if (footerText) {
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(footerText, left, doc.y, { width, align: 'center' });
      doc.moveDown(0.5);
    }
    doc.font('Helvetica').fontSize(7).fillColor('#999')
      .text('Dieser Beleg wurde elektronisch erzeugt und dient als Kassenbeleg gemäß § 146a AO.', left, doc.y, { width, align: 'center' });
  }

  private formatOptions(item: OrderItem): string[] {
    const selected =
      (item.options as {
        selected?: Array<{ option?: string; excluded?: boolean; priceModifier?: number }>;
      } | null)?.selected ?? [];
    return selected
      .map((o) => {
        const name = o.option ?? '';
        if (!name) return '';
        if (o.excluded) return `ohne ${name}`;
        if (Number(o.priceModifier) > 0) return `+ ${name}`;
        return name;
      })
      .filter(Boolean);
  }

  private formatCurrency(amount: number | string): string {
    return `${Number(amount).toFixed(2)} €`;
  }

  private paymentMethodLabel(method: string): string {
    const labels: Record<string, string> = {
      cash: 'Bar bezahlt',
      card: 'Karte bezahlt',
      sumup_terminal: 'Karte bezahlt',
      sumup_online: 'Online bezahlt',
    };
    return labels[method] || 'Bezahlt';
  }

  private formatDateTime(value: string | Date): string {
    const date = typeof value === 'string' ? new Date(value) : value;
    return date.toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Berlin',
    });
  }
}
