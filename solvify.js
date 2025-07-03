// solvify.js  — LeetCode Daily Auto-Submit (Node ≥ 18)
const playwright = require('playwright');

(async () => {
  const { LEETCODE_SESSION, LEETCODE_CSRF: CSRF_TOKEN } = process.env;
  if (!LEETCODE_SESSION || !CSRF_TOKEN) {
    console.error('❌  Set both LEETCODE_SESSION and LEETCODE_CSRF env vars.');
    process.exit(1);
  }

  /* ───── 1. Browser (for editorial HTML) ───── */
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  await context.addCookies([
    {
      name: 'LEETCODE_SESSION',
      value: LEETCODE_SESSION,
      domain: '.leetcode.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'csrftoken',
      value: CSRF_TOKEN,
      domain: '.leetcode.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();

  /* ───── 2. API context (all cookies pre-attached) ───── */
  const cookieHdr = `LEETCODE_SESSION=${LEETCODE_SESSION}; csrftoken=${CSRF_TOKEN}`;
  const api = await playwright.request.newContext({
    baseURL: 'https://leetcode.com',
    extraHTTPHeaders: {
      Cookie: cookieHdr,
      'x-csrftoken': CSRF_TOKEN,
      Origin: 'https://leetcode.com',
      Referer: 'https://leetcode.com',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  });

  try {
    /* ───── 3. Daily challenge metadata ───── */
    const dailyQuery = `
      query questionOfToday {
        activeDailyCodingChallengeQuestion {
          question { titleSlug questionId title }
        }
      }`;
    const daily = (
      await (
        await api.post('/graphql', {
          data: { query: dailyQuery, operationName: 'questionOfToday' },
        })
      ).json()
    ).data.activeDailyCodingChallengeQuestion;
    if (!daily) throw new Error('Daily challenge query failed.');

    const { titleSlug: slug, questionId, title } = daily.question;
    console.log(`🔎  Today: ${title}   (slug: ${slug})`);

    /* ───── 4. Find a C++ solution ───── */
    let cpp = null;

    /* 4-A  Editorial */
    try {
      const ed = await context.newPage();
      await ed.goto(`https://leetcode.com/problems/${slug}/solution/`, {
        waitUntil: 'domcontentloaded',
      });
      cpp = await ed.$$eval('pre code', (ns) =>
        ns.map((n) => n.innerText).find((t) => /class\s+Solution/.test(t)),
      );
      await ed.close();
    } catch (_) {}

    /* 4-B  GraphQL questionSolutions */
    if (!cpp) {
      console.log('🔗  GraphQL: questionSolutions …');
      const q = `
        query GetSol($slug:String!){
          questionSolutions(
            questionSlug:$slug
            first:10
            orderBy:most_votes
            languageTags:["cpp"]
          ){ nodes { code } }
        }`;
      const nodes =
        (
          await (
            await api.post('/graphql', {
              data: { query: q, variables: { slug }, operationName: 'GetSol' },
            })
          ).json()
        ).data?.questionSolutions?.nodes ?? [];
      if (nodes.length) cpp = nodes[0].code;
    }

    /* 4-C  __NEXT_DATA__ on /solutions */
    if (!cpp) {
      console.log('📚  Parsing solutions page …');
      const html = await (
        await api.get(
          `/problems/${slug}/solutions/?orderBy=most_votes&languageTags=cpp`,
        )
      ).text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (m) {
        const jd = JSON.parse(m[1]);
        const stack = [jd];
        while (stack.length) {
          const n = stack.pop();
          if (n && typeof n === 'object') {
            if (typeof n.code === 'string' && /class\s+Solution/.test(n.code)) {
              cpp = n.code;
              break;
            }
            for (const k in n) stack.push(n[k]);
          }
        }
      }
    }

    /* 4-D  Discuss page HTML fallback (NEW) */
    if (!cpp) {
      console.log('💬  Scraping Discuss page …');
      const html = await (
        await api.get(
          `/problems/${slug}/discuss/?orderBy=most_votes&language=cpp`,
        )
      ).text();
      const decode = (s) =>
        s
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
      const matches = Array.from(
        html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g),
      ).map((m) => decode(m[1]));
      cpp = matches.find((t) => /class\s+Solution/.test(t) || /#include/.test(t));
    }

    if (!cpp) throw new Error('No C++ solution found.');

    /* ───── 5. Submit ───── */
    const submit = await api.post(`/problems/${slug}/submit/`, {
      data: {
        question_id: questionId,
        lang: 'cpp',
        typed_code: cpp,
        test_mode: false,
        questionSlug: slug,
      },
    });
    const submitTxt = await submit.text();
    let submitJson = {};
    try {
      submitJson = JSON.parse(submitTxt);
    } catch (_) {}
    const id = submitJson.submission_id;
    if (!id) {
      console.error('⛔  Submit reply (no id):', submitTxt);
      throw new Error('submission_id missing.');
    }
    console.log(`🚀  Submitted — id ${id}`);

    /* ───── 6. Poll ───── */
    const poll = `/submissions/detail/${id}/check/`;
    let res, msg;
    for (let waited = 0; waited < 30_000; waited += 2_000) {
      await new Promise((r) => setTimeout(r, 2_000));
      res = await (await api.post(poll, { data: {} })).json();
      msg = res.status_msg;
      if (res.state === 'SUCCESS' && res.status_code !== 14) break;
    }

    console.log(`📝  Result: ${msg || 'Unknown'}`);
    if (msg === 'Accepted')
      console.log(`   Runtime ${res.status_runtime}   Memory ${res.status_memory}`);
    else if (res.full_compile_error)
      console.log(`   Compile error:\n${res.full_compile_error}`);
  } catch (e) {
    console.error('❌ ', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await api.dispose();
  }
})();
