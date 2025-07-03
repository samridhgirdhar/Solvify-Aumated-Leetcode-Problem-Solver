// leetcode_submit.js
const playwright = require('playwright');

(async () => {
  const LEETCODE_SESSION = process.env.LEETCODE_SESSION;
  const CSRF_TOKEN = process.env.LEETCODE_CSRF;
  if (!LEETCODE_SESSION || !CSRF_TOKEN) {
    console.error("LeetCode session cookie or CSRF token not provided. Make sure secrets are set.");
    process.exit(1);
  }

  // 1. Launch headless browser context with LeetCode cookies (to be logged in)
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    // Set a realistic user agent (optional, Playwright has a decent default, but we can mimic a common browser)
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36'
  });
  // Add LeetCode session cookies to context
  await context.addCookies([
    {
      name: 'LEETCODE_SESSION',
      value: LEETCODE_SESSION,
      domain: '.leetcode.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    },
    {
      name: 'csrftoken',
      value: CSRF_TOKEN,
      domain: '.leetcode.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }
  ]);

  const page = await context.newPage();

  try {
    // 2. Fetch today's daily challenge info via GraphQL
    const dailyQuery = `query questionOfToday {
      activeDailyCodingChallengeQuestion {
        date
        link
        question {
          titleSlug
          questionId
          title
          hasSolution
        }
      }
    }`;
    const response = await page.request.post('https://leetcode.com/graphql', {
      headers: {
        'Content-Type': 'application/json'
      },
      data: { query: dailyQuery, operationName: "questionOfToday" }
    });
    const data = await response.json();
    const challenge = data.data.activeDailyCodingChallengeQuestion;
    if (!challenge) {
      throw new Error("Could not retrieve daily challenge question.");
    }
    const problemSlug = challenge.question.titleSlug;
    const questionId = challenge.question.questionId;
    console.log(`🔎 Today's problem: ${challenge.question.title} (slug: ${problemSlug})`);

    // ---------------- 3️⃣  Fetch an accepted C++ solution ----------------
    let cppSolutionCode = null;

    /* 3‑A. Official editorial */
    try {
    const editorial = await context.newPage();
    await editorial.goto(`https://leetcode.com/problems/${problemSlug}/solution/`,
                        { waitUntil: 'domcontentloaded' });
    const code = await editorial.$$eval('pre code', nodes =>
        nodes.map(n => n.innerText).find(t => /#include/.test(t) || /std::/.test(t)));
    if (code) cppSolutionCode = code;
    await editorial.close();
    } catch { /* ignore */ }

    /* 3‑B. Community solutions via GraphQL (fast & headless) */
    if (!cppSolutionCode) {
    console.log('🔗 Querying questionSolutions GraphQL …');
    const gqlQuery = `
        query GetSolutions($slug: String!) {
        questionSolutions(questionSlug: $slug, first: 5, orderBy: most_votes, languageTags: ["cpp"]) {
            nodes { codeSnippet }
        }
        }`;
    const resp = await page.request.post('https://leetcode.com/graphql', {
        headers: { 'Content-Type': 'application/json' },
        data: { query: gqlQuery, variables: { slug: problemSlug }, operationName: 'GetSolutions' }
    });
    const solData = await resp.json();
    const nodes = solData?.data?.questionSolutions?.nodes || [];
    if (nodes.length && nodes[0].codeSnippet) {
        cppSolutionCode = nodes[0].codeSnippet.replace(/\r\n/g, '\n');
    }
    }

    /* 3‑C. Fallback: parse __NEXT_DATA__ from the Solutions page */
    if (!cppSolutionCode) {
    console.log('📚 Parsing Solutions page JSON …');
    const solHtml = await (await page.request.get(
        `https://leetcode.com/problems/${problemSlug}/solutions/?orderBy=most_votes&languageTags=cpp`
        )).text();
    const jsonMatch = solHtml.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
    if (jsonMatch) {
        const nextData = JSON.parse(jsonMatch[1]);
        const snippets = nextData?.props?.pageProps?.dehydratedState?.queries
        ?.flatMap(q => q.state?.data?.questionSolutions?.nodes || []);
        const firstCpp = snippets?.find(n => /#include/.test(n.codeSnippet));
        if (firstCpp) cppSolutionCode = firstCpp.codeSnippet.replace(/\r\n/g, '\n');
    }
    }

    /* 3‑D. Last fallback: Discuss */
    if (!cppSolutionCode) {
    console.log('💬 Falling back to Discuss …');
    await page.goto(`https://leetcode.com/problems/${problemSlug}/discuss/?orderBy=most_votes`);
    await page.waitForSelector('a[data-e2e-locator="post-title"]', { timeout: 12000 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        (await page.$('a[data-e2e-locator="post-title"]')).click()
    ]);
    const code = await page.$$eval('pre code', nodes =>
        nodes.map(n => n.innerText).find(t => /#include/.test(t)));
    if (code) cppSolutionCode = code;
    }

    if (!cppSolutionCode) {
    throw new Error('C++ solution not found in editorial, Solutions tab, or Discuss.');
    }
    console.log('✅ C++ solution acquired.');



    // 4. Submit the solution via LeetCode API
    const submitUrl = `https://leetcode.com/problems/${problemSlug}/submit/`;
    const submitPayload = {
      question_id: questionId,
      lang: "cpp",
      typed_code: cppSolutionCode,
      // other fields as observed: 
      test_mode: false,
      questionSlug: problemSlug
    };
    const submitResp = await page.request.post(submitUrl, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrftoken': CSRF_TOKEN,
        'Referer': `https://leetcode.com/problems/${problemSlug}/`  // referer header for safety
      },
      data: submitPayload
    });
    if (!submitResp.ok()) {
      throw new Error(`Submit request failed with status ${submitResp.status()}`);
    }
    const submitResult = await submitResp.json();
    const submissionId = submitResult.submission_id;
    if (!submissionId) {
      throw new Error("Failed to get submission_id from response.");
    }

    // Poll the submission status until done
    const checkUrl = `https://leetcode.com/submissions/detail/${submissionId}/check/`;
    let checkResult, statusMsg;
    for (let attempt = 0; attempt < 10; attempt++) {  // poll up to ~10 times (with delay)
      await page.waitForTimeout(2000);  // wait 2 seconds before each check
      const checkResp = await page.request.post(checkUrl, {
        headers: {
          'Content-Type': 'application/json',
          'x-csrftoken': CSRF_TOKEN
        }
      });
      checkResult = await checkResp.json();
      statusMsg = checkResult.status_msg;
      if (checkResult.state === "SUCCESS" && checkResult.status_code !== 14) { 
        // status_code 14 = queued, anything else means finished (10=AC, 11=WA, 20=CE, etc.)
        break;
      }
    }

    // 5. Log the outcome
    if (checkResult) {
      console.log(`📝 Submission Result: ${statusMsg || "Unknown"}`);
      if (statusMsg === "Accepted") {
        console.log(`💡 Runtime: ${checkResult.status_runtime}, Memory: ${checkResult.status_memory}`);
      } else if (checkResult.full_compile_error) {
        console.log(`💡 Compile Error: ${checkResult.full_compile_error}`);
      } else if (checkResult.status_msg === "Wrong Answer") {
        console.log(`💡 Last Testcase: ${checkResult.last_testcase}`);
        console.log(`💡 Expected Output: ${checkResult.expected_output}, Your Output: ${checkResult.code_output}`);
      }
    } else {
      console.log("❓ Submission status unknown (no response).");
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
