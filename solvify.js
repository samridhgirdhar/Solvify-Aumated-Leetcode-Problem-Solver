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

    /* 3‑A. Official editorial (if you have access) */
    try {
    const editorial = await context.newPage();
    await editorial.goto(`https://leetcode.com/problems/${problemSlug}/solution/`,
                        { waitUntil: 'domcontentloaded' });
    await editorial.waitForSelector('pre code', { timeout: 8000 });
    for (const block of await editorial.$$('pre code')) {
        const text = await block.innerText();
        if (text.includes('#include') || /class\s+\w+\s*\{/.test(text)) {
        cppSolutionCode = text;
        break;
        }
    }
    await editorial.close();
    } catch { /* fall through */ }

    /* 3‑B. Community “Solutions” tab (2025 layout) */
    if (!cppSolutionCode) {
    console.log('📚 Searching Solutions tab …');
    const solTab = await context.newPage();
    const solURL =
        `https://leetcode.com/problems/${problemSlug}/solutions/?orderBy=most_votes&languageTags=cpp`;
    await solTab.goto(solURL, { waitUntil: 'domcontentloaded' });
    await solTab.waitForSelector('pre code', { timeout: 15000 });
    for (const block of await solTab.$$('pre code')) {
        const text = await block.innerText();
        if (text.includes('#include')) {
        cppSolutionCode = text;
        break;
        }
    }
    await solTab.close();
    }

    /* 3‑C. Fallback: first post in Discuss */
    if (!cppSolutionCode) {
    console.log('💬 Falling back to Discuss …');
    await page.goto(`https://leetcode.com/problems/${problemSlug}/discuss/?orderBy=most_votes`);
    await page.waitForSelector('a[data-e2e-locator="post-title"]', { timeout: 12000 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        (await page.$('a[data-e2e-locator="post-title"]')).click()
    ]);
    const blocks = await page.$$('pre code');
    for (const block of blocks) {
        const text = await block.innerText();
        if (text.includes('#include')) {
        cppSolutionCode = text;
        break;
        }
    }
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
