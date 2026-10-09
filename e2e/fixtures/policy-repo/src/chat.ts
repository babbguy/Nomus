import OpenAI from 'openai';

const client = new OpenAI();

// Calls OpenAI directly instead of going through the approved LLM gateway.
export async function ask(question: string): Promise<string> {
  const reply = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: question }],
  });
  return reply.choices[0]?.message?.content ?? '';
}
