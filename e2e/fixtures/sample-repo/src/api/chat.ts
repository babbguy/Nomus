import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const openai = new OpenAI();
const anthropic = new Anthropic();

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

// Customer-facing chat assistant for the web widget.
export async function chatWithCustomer(history: ChatMessage[], patientId: string) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'You are a virtual assistant.' }, ...history],
  });
  return completion.choices[0]?.message?.content ?? '';
}

export async function summarizeMedicalHistory(patientRecord: { diagnosis: string; medications: string[] }) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: `Summarize: ${JSON.stringify(patientRecord)}` }],
  });
  return res.content;
}
