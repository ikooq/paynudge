// PayPal's INVOICING.INVOICE.PAID event can represent partial or pending payments.
export function describeWebhookEvent(event) {
  const invoice = event.resource?.invoice || event.resource || {};
  const number = invoice.detail?.invoice_number || invoice.id || "?";
  const messages = {
    "INVOICING.INVOICE.PAID": `PayPal reported payment activity for invoice #${number}; check the refreshed status and balance.`,
    "INVOICING.INVOICE.CANCELLED": `PayPal reports invoice #${number} was cancelled`,
    "INVOICING.INVOICE.REFUNDED": `PayPal reports refund activity for invoice #${number}; check the refreshed status and balance.`,
  };
  return messages[event.event_type] ? { text: messages[event.event_type], invoiceId: invoice.id } : null;
}
