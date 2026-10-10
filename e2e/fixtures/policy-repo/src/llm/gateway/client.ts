import OpenAI from 'openai';

const client = new OpenAI();

// The approved LLM gateway: the only place allowed to call OpenAI directly.
export async function complete(prompt: string): Promise<string> {
  const reply = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  });
  return reply.choices[0]?.message?.content ?? '';
}
