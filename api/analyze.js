export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const qwenKey = process.env.DASHSCOPE_API_KEY;
  const avKey = process.env.ALPHAVANTAGE_API_KEY;

  if (!qwenKey) return res.status(500).json({ error: 'AI Key 未配置' });

  try {
    const { messages, system, stream, max_tokens, ticker, market } = req.body;

    // ── 拉取实时财务数据（仅美股）──
    let realData = '';
    if (ticker && market === 'us' && avKey) {
      try {
        const [overviewRes, incomeRes, quoteRes] = await Promise.all([
          fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${avKey}`),
          fetch(`https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${avKey}`),
          fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${avKey}`)
        ]);

        const [overview, income, quote] = await Promise.all([
          overviewRes.json(),
          incomeRes.json(),
          quoteRes.json()
        ]);

        const latest = income?.annualReports?.[0] || {};
        const q = quote?.['Global Quote'] || {};
        const reportDate = latest.fiscalDateEnding || '未知';
        const revenue = latest.totalRevenue ? (parseInt(latest.totalRevenue) / 1e9).toFixed(1) + '十亿美元' : '未知';
        const netIncome = latest.netIncome ? (parseInt(latest.netIncome) / 1e9).toFixed(1) + '十亿美元' : '未知';
        const grossProfit = latest.grossProfit && latest.totalRevenue
          ? ((parseInt(latest.grossProfit) / parseInt(latest.totalRevenue)) * 100).toFixed(1) + '%'
          : '未知';
        const price = q['05. price'] ? q['05. price'] + ' 美元' : '未知';
        const change = q['10. change percent'] || '未知';

        realData = `
以下是 ${ticker} 的最新真实财务数据，请基于这些数据进行分析，不要凭记忆猜测：
- 财报截止日期：${reportDate}
- 年营收：${revenue}
- 年净利润：${netIncome}
- 毛利率：${grossProfit}
- 市盈率(PE)：${overview.PERatio || '未知'}
- 市值：${overview.MarketCapitalization ? (parseInt(overview.MarketCapitalization) / 1e9).toFixed(0) + '十亿美元' : '未知'}
- 当前股价：${price}（今日涨跌：${change}）
- 负债总额：${latest.totalLiabilities ? (parseInt(latest.totalLiabilities) / 1e9).toFixed(1) + '十亿美元' : '未知'}
- 公司描述：${overview.Description ? overview.Description.slice(0, 200) : '未知'}
`;
      } catch (e) {
        realData = '（实时数据获取失败，请基于已知信息分析，并注明数据可能不是最新）';
      }
    }

    // ── 构建消息 ──
    const qwenMessages = [];
    if (system) qwenMessages.push({ role: 'system', content: system });

    // 把实时数据注入到第一条用户消息
    const msgsWithData = messages.map((m, i) => {
      if (i === 0 && m.role === 'user' && realData) {
        return { role: 'user', content: realData + '\n\n' + m.content };
      }
      return m;
    });

    msgsWithData.forEach(m => qwenMessages.push({ role: m.role, content: m.content }));

    // ── 调用通义千问 ──
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${qwenKey}`,
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
