import OpenAI from 'openai';

const legacyClient = new OpenAI();

// Legacy direct call kept for an old integration.
export async function legacyAsk(question: string): Promise<string> {
  const reply = await legacyClient.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: question }] });
  return reply.choices[0]?.message?.content ?? '';
}
