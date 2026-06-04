export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API Key 未配置' });
  }

  try {
    const { messages, system, stream, max_tokens } = req.body;

    const qwenMessages = [];
    if (system) qwenMessages.push({ role: 'system', content: system });
    messages.forEach(m => qwenMessages.push({ role: m.role, content: m.content }));

    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'qwen-plus',
        messages: qwenMessages,
        max_tokens: max_tokens || 1200,
        stream: stream || false,
      }),
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) res.write(`data: ${JSON.stringify({ delta: { text: delta } })}\n\n`);
          } catch(e) {}
        }
      }
      res.end();
    } else {
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';
      res.status(200).json({ content: [{ type: 'text', text }] });
    }
  } catch (error) {
    res.status(500).json({ error: '请求失败: ' + error.message });
  }
}
