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

    // 3. Retrieve an accepted C++ solution for the problem
    let cppSolutionCode = null;

    if (challenge.question.hasSolution) {
      // Attempt to get official solution editorial page
      console.log("📖 Official solution available. Attempting to fetch editorial...");
      const solPage = await context.newPage();
      await solPage.goto(`https://leetcode.com/problems/${problemSlug}/solution/`);
      // Wait for content to load (the editorial may load code blocks asynchronously)
      await solPage.waitForTimeout(3000);
      // Check for code blocks in the page (especially for C++ code)
      const codeBlocks = await solPage.$$('pre code');
      for (const codeBlock of codeBlocks) {
        const codeText = await codeBlock.innerText();
        // Heuristic: consider it C++ if it has common C++ keywords or includes
        if (codeText.includes('#include') || codeText.includes('std::') || codeText.includes('using namespace') ) {
          cppSolutionCode = codeText;
          break;
        }
      }
      await solPage.close();
    }

    if (!cppSolutionCode) {
      console.log("💬 Fetching top Discuss post for C++ solution...");
      // Open Discuss tab sorted by most votes
      await page.goto(`https://leetcode.com/problems/${problemSlug}/discuss/?orderBy=most_votes`);
      // Wait for discuss posts to load
      await page.waitForSelector('div[class*="discuss-list"]');
      // Click the first post (most voted)
      const firstPostLink = await page.$('a[href*="/discuss/"]:nth-of-type(1)');
      if (!firstPostLink) throw new Error("Failed to find discuss posts.");
      await Promise.all([
        page.waitForNavigation(), 
        firstPostLink.click()
      ]);
      // On the post page, extract the first C++ code block
      const codeBlocks = await page.$$('pre code');
      for (const codeBlock of codeBlocks) {
        const codeText = await codeBlock.innerText();
        // Identify C++ code by common patterns (to avoid picking up Python/Java)
        if (codeText.includes('#include') || codeText.includes('std::') || codeText.includes(';')) {
          cppSolutionCode = codeText;
          break;
        }
      }
    }

    if (!cppSolutionCode) {
      throw new Error("C++ solution not found in Solutions or Discuss.");
    }

    console.log("✅ Retrieved C++ solution. Submitting to LeetCode...");

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
