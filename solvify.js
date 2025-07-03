// solvify.js  -- LeetCode Daily Auto-Submit
const playwright = require('playwright');

(async () => {
  const { LEETCODE_SESSION, LEETCODE_CSRF: CSRF_TOKEN } = process.env;
  if (!LEETCODE_SESSION || !CSRF_TOKEN) {
    console.error('Missing LEETCODE_SESSION or LEETCODE_CSRF secret');
    process.exit(1);
  }

  /* ───────────────────────── 1. Launch browser (for HTML-only steps) ───────────────────────── */
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
  const page = await context.newPage(); // only for editorial HTML scraping

  /* ───────────────────────── 2. Create an API-only request context (carries cookies) ───────── */
  const cookieHeader = `LEETCODE_SESSION=${LEETCODE_SESSION}; csrftoken=${CSRF_TOKEN}`;
  const api = await playwright.request.newContext({
    baseURL: 'https://leetcode.com',
    extraHTTPHeaders: {
      Cookie: cookieHeader,
      'x-csrftoken': CSRF_TOKEN,
      Origin: 'https://leetcode.com',
      Referer: 'https://leetcode.com',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  });

  try {
    /* ───────────────────────── 3. Fetch today’s challenge metadata ─────────────────────────── */
    const dailyQuery = `
      query questionOfToday {
        activeDailyCodingChallengeQuestion {
          date
          link
          question { titleSlug questionId title hasSolution }
        }
      }`;
    const dailyResp = await api.post('/graphql', {
      data: { query: dailyQuery, operationName: 'questionOfToday' },
    });
    const daily = (await dailyResp.json()).data.activeDailyCodingChallengeQuestion;
    if (!daily) throw new Error('Could not retrieve daily challenge question.');

    const { titleSlug: problemSlug, questionId, title } = daily.question;
    console.log(`🔎  Today's problem: ${title}  (slug: ${problemSlug})`);

    /* ───────────────────────── 4. Acquire an accepted C++ solution ─────────────────────────── */
    let cppSolutionCode = null;

    /* 4-A. Official editorial (HTML) */
    try {
      const edt = await context.newPage();
      await edt.goto(`https://leetcode.com/problems/${problemSlug}/solution/`, {
        waitUntil: 'domcontentloaded',
      });
      cppSolutionCode = await edt.$$eval('pre code', (nodes) =>
        nodes.map((c) => c.innerText).find((t) => /class\s+Solution/.test(t)),
      );
      await edt.close();
    } catch {
      /* ignore */
    }

    /* 4-B. GraphQL questionSolutions */
    if (!cppSolutionCode) {
      console.log('🔗  GraphQL: questionSolutions …');
      const q = `
        query GetSol($slug: String!) {
          questionSolutions(
            questionSlug: $slug
            first: 5
            orderBy: most_votes
            languageTags: ["cpp"]
          ) {
            nodes { code }
          }
        }`;
      const r = await api.post('/graphql', {
        data: { query: q, variables: { slug: problemSlug }, operationName: 'GetSol' },
      });
      const nodes = r.ok() ? (await r.json()).data?.questionSolutions?.nodes : [];
      if (nodes?.length) cppSolutionCode = nodes[0].code;
    }

    /* 4-C. Parse __NEXT_DATA__ JSON (always present) */
    if (!cppSolutionCode) {
      console.log('📚  Parsing __NEXT_DATA__ …');
      const html = await (await api.get(
        `/problems/${problemSlug}/solutions/?orderBy=most_votes&languageTags=cpp`,
      )).text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (m) {
        const jd = JSON.parse(m[1]);
        const stack = [jd];
        while (stack.length) {
          const node = stack.pop();
          if (node && typeof node === 'object') {
            if (typeof node.code === 'string' && /class\s+Solution/.test(node.code)) {
              cppSolutionCode = node.code;
              break;
            }
            for (const k in node) stack.push(node[k]);
          }
        }
      }
    }

    if (!cppSolutionCode) throw new Error('No C++ solution found.');

    /* ───────────────────────── 5. Submit the solution ──────────────────────────────────────── */
    const submitPayload = {
      question_id: questionId,
      lang: 'cpp',
      typed_code: cppSolutionCode,
      test_mode: false,
      questionSlug: problemSlug,
    };
    const submitResp = await api.post(`/problems/${problemSlug}/submit/`, {
      data: submitPayload,
    });
    const submitText = await submitResp.text();
    let submitJson = {};
    try {
      submitJson = JSON.parse(submitText);
    } catch {/* ignore malformed */ }
    const submissionId = submitJson.submission_id;
    if (!submissionId) {
      console.error('⛔  Submit reply (no submission_id):', submitText);
      throw new Error('Failed to get submission_id from response.');
    }
    console.log(`🚀  Submitted — submission_id: ${submissionId}`);

    /* ───────────────────────── 6. Poll until judged ────────────────────────────────────────── */
    const checkUrl = `/submissions/detail/${submissionId}/check/`;
    let checkResult, statusMsg;
    const maxWaitMs = 30_000;
    for (let waited = 0; waited < maxWaitMs; waited += 2_000) {
      await new Promise((res) => setTimeout(res, 2_000));
      const cr = await api.post(checkUrl, {
        data: {}, // LeetCode expects POST with empty body
      });
      checkResult = await cr.json();
      statusMsg = checkResult.status_msg;
      if (checkResult.state === 'SUCCESS' && checkResult.status_code !== 14) break; // 14=queued
    }

    /* ───────────────────────── 7. Report outcome ───────────────────────────────────────────── */
    if (checkResult) {
      console.log(`📝  Result: ${statusMsg || 'Unknown'}`);
      if (statusMsg === 'Accepted') {
        console.log(`   Runtime: ${checkResult.status_runtime}, Memory: ${checkResult.status_memory}`);
      } else if (checkResult.full_compile_error) {
        console.log(`   Compile Error:\n${checkResult.full_compile_error}`);
      } else if (statusMsg === 'Wrong Answer') {
        console.log(`   Last Testcase: ${checkResult.last_testcase}`);
        console.log(`   Expected: ${checkResult.expected_output}`);
        console.log(`   Your Out:  ${checkResult.code_output}`);
      }
    } else {
      console.log('❓  Submission status unknown.');
    }
  } catch (err) {
    console.error('❌  Error:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await api.dispose();
  }
})();
