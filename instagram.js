require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs/promises");
const readline = require("readline");

// Enhanced stealth configuration
puppeteer.use(StealthPlugin());

// Randomized delay to mimic human behavior
const randomDelay = (min, max) => {
  const randomTime = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, randomTime));
};

// Store API responses
let followersData = [];
let followingData = [];

// Function to safely extract user data from potentially partial responses
async function extractUsersFromPartialResponse(page, listType) {
  console.log(`📤 Attempting to extract ${listType} data from page content...`);

  const extractedData = await page.evaluate((type) => {
    try {
      // Get page content as text
      const content = document.body.innerText;

      // If empty content or error page, return empty array
      if (!content || content.length < 10 || content.includes("Please wait")) {
        return { success: false, error: "Empty or loading response" };
      }

      // Look for partial JSON patterns in the content
      const userPattern = /"username":"([^"]+)","full_name":"([^"]*)"/g;
      const users = [];
      let match;

      // Extract all username/full_name pairs
      while ((match = userPattern.exec(content)) !== null) {
        users.push({
          username: match[1],
          full_name: match[2] || "",
          id: null, // We might not be able to extract IDs reliably
        });
      }

      return {
        success: true,
        users: users,
        // Try to extract pagination info
        hasNextPage: /has_next_page":true/.test(content),
        endCursor: (content.match(/"end_cursor":"([^"]+)"/) || [null, null])[1],
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, listType);

  if (!extractedData.success) {
    console.log(
      `⚠️ Failed to extract ${listType} data: ${extractedData.error}`
    );
    return null;
  }

  console.log(
    `✅ Successfully extracted ${extractedData.users.length} ${listType}`
  );
  return extractedData;
}

// Improved API data fetching function
async function fetchInstagramListViaAPI(page, userId, listType) {
  console.log(`📥 Fetching ${listType} via Instagram API...`);

  // Define query hash based on list type
  const queryHash =
    listType === "followers"
      ? "c76146de99bb02f6415203be841dd25a" // For followers
      : "d04b0a864b4b54837c0d870b0e77e076"; // For following

  // Prepare query variables
  let hasNextPage = true;
  let endCursor = "";
  let count = 0;
  let maxRetries = 5;
  let collectedUsers = [];

  // Make paginated API requests until we've fetched all users
  while (hasNextPage && count < 100) {
    count++;
    let retryCount = 0;
    let success = false;

    while (!success && retryCount < maxRetries) {
      try {
        // Construct variables for the GraphQL query
        const variables = {
          id: userId,
          include_reel: true,
          fetch_mutual: false,
          first: 24, // Reduced batch size to avoid rate limits
          after: endCursor,
        };

        // Create API URL with encoded variables
        const url = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(
          JSON.stringify(variables)
        )}`;

        console.log(
          `🔄 Making API request #${count} for ${listType} (attempt ${
            retryCount + 1
          })...`
        );

        // Navigate to the API URL
        await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

        // Add delay to ensure page loads
        await randomDelay(3000, 5000);

        // Use our improved extraction function
        const extractedData = await extractUsersFromPartialResponse(
          page,
          listType
        );

        if (!extractedData || extractedData.users.length === 0) {
          throw new Error("Failed to extract user data from response");
        }

        // Add extracted users to our collection
        collectedUsers = collectedUsers.concat(extractedData.users);
        console.log(`📊 Total ${listType} collected: ${collectedUsers.length}`);

        // Update pagination info
        hasNextPage = extractedData.hasNextPage;
        endCursor = extractedData.endCursor;

        if (!endCursor && hasNextPage) {
          console.log(
            "⚠️ End cursor missing but has next page is true. Stopping pagination."
          );
          hasNextPage = false;
        }

        success = true;

        // Add random delay between requests
        if (hasNextPage) {
          const delayTime = 3000 + Math.random() * 4000;
          console.log(
            `Waiting ${Math.round(
              delayTime / 1000
            )} seconds before next request...`
          );
          await randomDelay(3000, 7000);
        }
      } catch (error) {
        retryCount++;
        console.log(
          `⚠️ Error in API request (${retryCount}/${maxRetries}): ${error.message}`
        );

        if (retryCount >= maxRetries) {
          console.log(
            `❌ Failed after ${maxRetries} retries for ${listType}, moving on`
          );
          hasNextPage = false;
          break;
        }

        // Exponential backoff between retries
        const backoffTime = Math.min(10000 * Math.pow(1.5, retryCount), 30000);
        console.log(
          `Waiting ${Math.round(backoffTime / 1000)} seconds before retry...`
        );
        await randomDelay(backoffTime, backoffTime + 2000);
      }
    }
  }

  // Update the global data arrays
  if (listType === "followers") {
    followersData = collectedUsers;
  } else {
    followingData = collectedUsers;
  }

  // Return to the feed page
  await page.goto(`https://www.instagram.com/`, { waitUntil: "networkidle2" });
}

async function start() {
  console.log("📌 Instagram Unfollowers Bot (Stealth Mode)\n");

  // Create readline interface for user input
  const { stdin: input, stdout: output } = require("node:process");
  const rl = readline.createInterface({ input, output });

  const askQuestion = (query) =>
    new Promise((resolve) => rl.question(query, resolve));

  // Get user input for username & password
  const username = await askQuestion("Enter Instagram Username: ");
  const password = await askQuestion("Enter Instagram Password: ");
  rl.close();

  // Advanced browser launch options for better stealth
  const browser = await puppeteer.launch({
    headless: false, // Using visible browser for reliability
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-size=1280,800",
      "--disable-blink-features=AutomationControlled", // Prevents detection
    ],
    ignoreDefaultArgs: ["--enable-automation"], // Removes automation flag
  });

  const page = await browser.newPage();

  // Add random user agents rotation
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  ];

  const randomUserAgent =
    userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(randomUserAgent);

  // Additional privacy and stealth measures
  await page.evaluateOnNewDocument(() => {
    // Override the navigator properties
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Override the languages with random order
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // Add a fake notification API
    if (!window.Notification) {
      window.Notification = { permission: "default" };
    }
  });

  try {
    console.log("🌐 Navigating to Instagram...");

    // Navigate to Instagram with reliable parameters
    await page.goto("https://www.instagram.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Handle cookie consent if it appears
    try {
      const cookieButtons = await page.$$("button");
      for (const button of cookieButtons) {
        const text = await page.evaluate((el) => el.textContent, button);
        if (text.includes("Accept") || text.includes("Allow")) {
          await button.click();
          await randomDelay(500, 1000);
          break;
        }
      }
    } catch (e) {
      console.log("No cookie prompt detected");
    }

    // Check if login form exists
    const loginFormExists = await page.evaluate(() => {
      return !!document.querySelector('input[name="username"]');
    });

    if (loginFormExists) {
      console.log("🔐 Performing login...");

      // Type credentials with human-like timing
      await page.waitForSelector('input[name="username"]', {
        visible: true,
        timeout: 10000,
      });

      // Clear fields first
      await page.click('input[name="username"]', { clickCount: 3 });
      await page.keyboard.press("Backspace");

      // Type username with human-like delays
      await page.type('input[name="username"]', username, { delay: 100 });
      await randomDelay(300, 600);

      await page.click('input[name="password"]', { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type('input[name="password"]', password, { delay: 100 });

      await randomDelay(500, 1000);

      // Click login
      const loginButton = await page.$('button[type="submit"]');
      if (loginButton) {
        await loginButton.click();
      }

      // Wait for navigation to complete
      await page.waitForNavigation({ timeout: 60000 }).catch(() => {});

      // Handle "Save Login Info" prompt
      try {
        const notNowButtons = await page.$$("button");
        for (const button of notNowButtons) {
          const text = await page.evaluate((el) => el.textContent, button);
          if (text.includes("Not Now")) {
            await button.click();
            await randomDelay(1000, 2000);
            break;
          }
        }
      } catch (e) {
        console.log("No 'Save Login Info' prompt found");
      }

      // Handle notifications prompt
      try {
        await randomDelay(1000, 2000);
        const notNowButtons = await page.$$("button");
        for (const button of notNowButtons) {
          const text = await page.evaluate((el) => el.textContent, button);
          if (text.includes("Not Now")) {
            await button.click();
            break;
          }
        }
      } catch (e) {
        console.log("No notifications prompt found");
      }
    } else {
      console.log("✅ Already logged in");
    }

    // Verify login success
    const isLoggedIn = await page.evaluate(() => {
      return !document.querySelector('input[name="username"]');
    });

    if (!isLoggedIn) {
      throw new Error("Login failed! Please check your credentials.");
    }

    console.log("✅ Successfully logged in to Instagram!");
    await randomDelay(2000, 3000);

    // Navigate to current user's profile more reliably
    console.log("🔍 Finding your profile...");

    // Try multiple methods to find the profile
    const profileUrl = await page.evaluate(() => {
      // Try various selectors that might contain the profile link
      const selectors = [
        'a[href^="/"]:not([href="/"])',
        'nav a[href^="/"]',
        'header a[href^="/"]',
        'a[role="link"][href^="/"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const href = el.getAttribute("href");
          // Match profile URL pattern (just username)
          if (
            href &&
            href !== "/" &&
            !href.includes("/direct/") &&
            !href.includes("/explore/") &&
            href.match(/^\/[\w\._]+\/?$/)
          ) {
            return href;
          }
        }
      }
      return null;
    });

    if (profileUrl) {
      console.log(`Found profile URL: ${profileUrl}`);
      await page.goto(`https://www.instagram.com${profileUrl}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    } else {
      console.log(`Falling back to username: ${username}`);
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }

    // Extract user ID reliably
    console.log("🔍 Extracting user ID...");
    await randomDelay(2000, 3000);

    // Try multiple methods to extract user ID
    const userId = await page.evaluate(() => {
      // Method 1: Check window._sharedData
      if (window._sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user?.id) {
        return window._sharedData.entry_data.ProfilePage[0].graphql.user.id;
      }

      // Method 2: Check for ID in script tags
      for (const script of document.querySelectorAll("script")) {
        const text = script.textContent || script.innerText;
        if (text) {
          // Look for various ID patterns
          const userIdMatch = text.match(/"user_id":"(\d+)"/);
          const profileIdMatch = text.match(/"profilePage_(\d+)"/);
          const idMatch = text.match(/"id":"(\d+)"/);

          if (userIdMatch) return userIdMatch[1];
          if (profileIdMatch) return profileIdMatch[1];
          if (idMatch) return idMatch[1];
        }
      }

      return null;
    });

    if (!userId) {
      throw new Error(
        "Failed to extract user ID - this is required to proceed"
      );
    }

    console.log(`✅ Found user ID: ${userId}`);

    // Collect data using our improved method
    console.log("📥 Collecting followers and following data...");

    // Collect followers
    await fetchInstagramListViaAPI(page, userId, "followers");

    // Slight delay between API requests
    await randomDelay(2000, 3000);

    // Collect following
    await fetchInstagramListViaAPI(page, userId, "following");

    // Process the collected data
    console.log(`\n📊 Data summary:`);
    console.log(`- Followers: ${followersData.length}`);
    console.log(`- Following: ${followingData.length}`);

    // Find non-followers (people you follow who don't follow you back)
    const followerUsernames = followersData.map((user) => user.username);
    const nonFollowers = followingData.filter(
      (user) => !followerUsernames.includes(user.username)
    );

    console.log(
      `\n🚨 Found ${nonFollowers.length} people who don't follow you back:`
    );

    // Prepare detailed output
    const detailedOutput = nonFollowers.map(
      (user) => `${user.username} (${user.full_name || "No full name"})`
    );

    if (detailedOutput.length > 0) {
      console.log(detailedOutput.join("\n"));

      // Save to file
      await fs.writeFile(
        "non_followers.txt",
        detailedOutput.join("\n"),
        "utf-8"
      );
      console.log("\n📄 Non-followers saved to non_followers.txt");

      // Save detailed JSON data for reference
      await fs.writeFile(
        "detailed_data.json",
        JSON.stringify(
          {
            followers: followersData,
            following: followingData,
            nonFollowers: nonFollowers,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf-8"
      );
    } else {
      console.log("\n✅ Everyone you follow also follows you back!");
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    await browser.close();
    console.log("\n✅ Task Completed!");
  }
}

// Start the bot
start();
