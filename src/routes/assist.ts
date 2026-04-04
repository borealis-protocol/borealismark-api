import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../middleware/logger';

const router = Router();

const WriteSchema = z.object({
  text: z.string().min(1).max(10000),
  format: z.enum(['email', 'letter', 'blog', 'social', 'response', 'general']).default('email'),
  tone: z.enum(['professional', 'casual', 'formal', 'friendly', 'persuasive']).default('professional'),
});

const FORMAT_INSTRUCTIONS: Record<string, string> = {
  email: 'Format as a professional email with appropriate greeting and sign-off.',
  letter: 'Format as a formal letter with proper structure.',
  blog: 'Format as an engaging blog post with clear paragraphs.',
  social: 'Format as a concise, impactful social media post.',
  response: 'Format as a clear, well-structured response or reply.',
  general: 'Polish the text with proper grammar, clarity, and flow.',
};

const TONE_INSTRUCTIONS: Record<string, string> = {
  professional: 'Use a professional, competent tone.',
  casual: 'Use a relaxed, conversational tone.',
  formal: 'Use a formal, authoritative tone.',
  friendly: 'Use a warm, approachable tone.',
  persuasive: 'Use a compelling, persuasive tone.',
};

router.post('/write', async (req: Request, res: Response) => {
  try {
    const parsed = WriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { text, format, tone } = parsed.data;
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      res.status(503).json({ success: false, error: 'AI service not configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.' });
      return;
    }

    const isOpenRouter = !process.env.ANTHROPIC_API_KEY && !!process.env.OPENROUTER_API_KEY;
    const baseURL = isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.anthropic.com/v1';

    const systemPrompt = `You are a writing assistant. Your job is to take rough, unpolished text and transform it into clear, well-written content.

Rules:
- ${FORMAT_INSTRUCTIONS[format]}
- ${TONE_INSTRUCTIONS[tone]}
- Fix all grammar, spelling, and punctuation errors.
- Improve sentence structure and flow.
- Preserve the original meaning and intent.
- Do NOT add information the user didn't provide.
- Do NOT add placeholder text like [Your Name] unless the format requires it.
- Output ONLY the polished text. No explanations, no commentary.`;

    let result: string;

    if (isOpenRouter) {
      // OpenRouter (OpenAI-compatible)
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://borealisprotocol.ai',
          'X-Title': 'Borealis Writer',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Polish this text:\n\n${text}` },
          ],
          max_tokens: 4096,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        logger.error('OpenRouter error', { status: response.status, body: err });
        throw new Error('AI service error');
      }

      const data = await response.json();
      result = data.choices?.[0]?.message?.content || '';
    } else {
      // Native Anthropic API
      const response = await fetch(`${baseURL}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          temperature: 0.3,
          system: systemPrompt,
          messages: [
            { role: 'user', content: `Polish this text:\n\n${text}` },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        logger.error('Anthropic error', { status: response.status, body: err });
        throw new Error('AI service error');
      }

      const data = await response.json();
      result = data.content?.[0]?.text || '';
    }

    if (!result) throw new Error('Empty response from AI');

    logger.info('Writing assist completed', { format, tone, inputLen: text.length, outputLen: result.length });
    res.json({ success: true, result, format, tone });
  } catch (e: any) {
    logger.error('Assist write error', { error: e.message });
    res.status(500).json({ success: false, error: e.message || 'Failed to process writing' });
  }
});

export default router;
