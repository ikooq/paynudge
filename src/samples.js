// Sample client conversations for the demo. The `expected` drafts are only used in demo mode
// (no GEMINI_API_KEY); with a key, the AI reads the text for real.

export const samples = [
  {
    id: "bloom",
    label: "Designer · English chat",
    text: `Maya Chen (Bloom Coffee), Mon 10:14
Hi! Loved the first concepts 🙌 Let's go with option B for the logo.

Me, 10:20
Great choice! So final scope: logo package (option B, all formats) + 3 Instagram post templates. As quoted: $450 for the logo, $40 per template.

Maya Chen (Bloom Coffee), 10:22
Perfect. Could you also do a simple menu board in the same style?

Me, 10:25
Sure, the menu board is $120. I'll deliver everything by Wednesday.

Maya Chen (Bloom Coffee), 10:31
Deal. Send the invoice to maya@bloomcoffee.co, we usually pay within a week 👍`,
    expected: {
      client: { name: "Maya Chen", business_name: "Bloom Coffee", email: "maya@bloomcoffee.co" },
      currency: "USD",
      items: [
        { name: "Logo package (option B)", description: "Final logo in all formats", quantity: 1, unit_price: 450 },
        { name: "Instagram post template", description: "Designed in the new brand style", quantity: 3, unit_price: 40 },
        { name: "Menu board design", description: "Same style as the logo package", quantity: 1, unit_price: 120 },
      ],
      dueInDays: 7,
      payment_terms_label: "Due in 7 days",
      note_to_client: "Thanks for choosing option B, Maya! It was a pleasure building Bloom Coffee's new look.",
      summary: "Brand refresh for Bloom Coffee: logo, 3 Instagram templates and a menu board; warm, informal relationship.",
      conversation_language: "English",
      warnings: [],
    },
  },
  {
    id: "techstart",
    label: "Translator · Russian chat",
    text: `Дмитрий (TechStart): Добрый день! Нужно перевести наш сайт на английский, всего 12 страниц.
Я: Здравствуйте! Ставка 25$ за страницу. Если нужно к пятнице, то +50$ за срочность.
Дмитрий (TechStart): Да, к пятнице обязательно. И ещё нужна вычитка носителем языка.
Я: Вычитка носителем — 80$ за весь объём.
Дмитрий (TechStart): Ок, всё согласовано. Счёт на d.ivanov@techstart.kz, оплатим в течение 10 дней после получения счёта.`,
    expected: {
      client: { name: "Dmitry Ivanov", business_name: "TechStart", email: "d.ivanov@techstart.kz" },
      currency: "USD",
      items: [
        { name: "Website translation, Russian to English", description: "12 pages", quantity: 12, unit_price: 25 },
        { name: "Rush delivery fee", description: "Delivery by Friday", quantity: 1, unit_price: 50 },
        { name: "Native-speaker proofreading", description: "Full translated text", quantity: 1, unit_price: 80 },
      ],
      dueInDays: 10,
      payment_terms_label: "Net 10",
      note_to_client: "Thank you for trusting us with the TechStart website translation, Dmitry!",
      summary: "Website translation (12 pages) with rush delivery and native proofreading for TechStart; businesslike tone.",
      conversation_language: "Russian",
      warnings: [],
    },
  },
  {
    id: "olivo",
    label: "Photographer · Spanish chat, no email",
    text: `Lucía · Casa Olivo: ¡Hola! Necesitamos fotos de producto para la tienda online, unas 20 fotos.
Yo: Perfecto, 15€ por foto con edición incluida. Fondo blanco.
Lucía · Casa Olivo: Genial. ¿Y si añadimos 5 fotos de ambiente en la terraza?
Yo: Las de ambiente son 25€ cada una.
Lucía · Casa Olivo: Vale, hacemos todo. ¿Me mandas la factura?`,
    expected: {
      client: { name: "Lucía", business_name: "Casa Olivo", email: "" },
      currency: "EUR",
      items: [
        { name: "Product photo, white background", description: "Editing included", quantity: 20, unit_price: 15 },
        { name: "Lifestyle photo on the terrace", description: "", quantity: 5, unit_price: 25 },
      ],
      dueInDays: 0,
      payment_terms_label: "Due on receipt",
      note_to_client: "Gracias, Lucía! Looking forward to shooting Casa Olivo's products.",
      summary: "Product and lifestyle photo shoot for Casa Olivo's online store; friendly tone.",
      conversation_language: "Spanish",
      warnings: [
        "No client email in the chat. Add one, or send the invoice as a share link.",
        "The client said “about 20 photos”; confirm the final count.",
      ],
    },
  },
];

export function publicSamples() {
  return samples.map(({ id, label, text }) => ({ id, label, text }));
}
