// ESM-compatible exports of LinkedIn Playwright helpers

export async function save_top_job_postings(page, number_of_jobs = 3) {
  const SAVE_REGEX = /^Save /i;
  const SAVED_OR_SAVE_REGEX = /^(Save|Saved) /i;

  await page.goto('https://www.linkedin.com/jobs/');

  const modal = page.getByRole('dialog');
  if (await modal.count()) {
    const dismiss_btn = modal.getByRole('button', { name: 'Dismiss' });
    if (await dismiss_btn.isVisible()) {
      await dismiss_btn.click();
    }
  }

  const login_btn = page.getByRole('button', { name: 'Login as AI Agent', exact: true });
  if ((await login_btn.count()) && (await login_btn.isVisible())) {
    await login_btn.click();
    await page.waitForLoadState('networkidle');
  }

  const main_region = page.getByRole('main');
  const card_locator = main_region.getByRole('listitem');

  for (let i = 0; i < 30; i++) {
    if ((await card_locator.count()) >= number_of_jobs) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if ((await card_locator.count()) < number_of_jobs) {
    const visible = await card_locator.count();
    throw new Error(`Requested to save ${number_of_jobs} jobs but only ${visible} are visible after waiting.`);
  }

  for (let idx = 0; idx < number_of_jobs; idx++) {
    const card = main_region.getByRole('listitem').nth(idx);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    if (await card.isVisible()) {
      await card.click();
    } else {
      throw new Error(`Card #${idx + 1} is not visible and cannot be clicked.`);
    }

    const detail_btn = page.getByRole('button', { name: SAVED_OR_SAVE_REGEX });
    await detail_btn.waitFor({ state: 'visible', timeout: 15000 });

    const unsaved_btn = page.getByRole('button', { name: SAVE_REGEX });
    if (await unsaved_btn.isVisible()) {
      await unsaved_btn.click();
      await page.waitForTimeout(400);
    }
  }
}

export async function save_top_n_jobs(page, top_n = 3) {
  await page.goto('/jobs', { waitUntil: 'domcontentloaded' });

  const dismissBtn = page.getByRole('button', { name: 'Dismiss' });
  if (await dismissBtn.count() > 0) {
    await dismissBtn.click();
  }

  const aiBannerBtn = page.getByRole('button', { name: 'Login as AI Agent' });
  if (await aiBannerBtn.count() > 0) {
    await aiBannerBtn.click();
    await page.waitForTimeout(500);
  }

  const saveButtons = page.getByRole('button', { name: /^Save /i });
  for (let i = 0; i < 10; i++) {
    if (await saveButtons.count() > 0) break;
    await page.waitForTimeout(500);
  }

  const btnCount = await saveButtons.count();
  if (btnCount === 0) {
    return { success: false, total_jobs_parsed: 0, jobs: [] };
  }

  const savedJobs = [];
  for (let idx = 0; idx < btnCount; idx++) {
    if (savedJobs.length >= top_n) break;
    const btn = saveButtons.nth(idx);
    const label = (await btn.innerText()).trim();
    if (!label.toLowerCase().startsWith('save ')) continue;
    const match = label.match(/^Save (.+?) job/i);
    const jobTitle = (match ? match[1] : label.slice(5)).trim();
    await btn.click();
    await page.waitForTimeout(200);
    savedJobs.push(jobTitle);
  }

  return { success: savedJobs.length >= top_n, total_jobs_parsed: savedJobs.length, jobs: savedJobs };
}

export async function easy_apply_job(page, job_title, resume_path, phone_number = "") {
  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.goto("/jobs/collections/recommended/", { waitUntil: "load" });
  const collectionLoaded = async () => (await page.getByRole("listitem").count()) > 0;
  if (!(await collectionLoaded())) {
    await page.reload();
    if (!(await collectionLoaded())) {
      throw new Error("Jobs collection did not render – possible LinkedIn outage or rate-limit.");
    }
  }
  let jobLink = page.getByRole("link", { name: job_title, exact: true });
  if ((await jobLink.count()) === 0) {
    const prefixPat = new RegExp(`^${escapeRegExp(job_title)}\\b`, "i");
    const fallback = page.getByRole("link", { name: prefixPat });
    if ((await fallback.count()) === 1) {
      jobLink = fallback;
    } else {
      throw new Error(`Job titled '${job_title}' not found (or ambiguous) in carousel.`);
    }
  }
  await jobLink.first().click();
  const easyApplyBtn = page.getByRole("button", { name: /^Easy Apply/i });
  if ((await easyApplyBtn.count()) === 0) {
    return "skipped";
  }
  await easyApplyBtn.first().click();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const phoneBox = page.getByRole("textbox", { name: /Mobile phone number/i });
    if ((await phoneBox.count()) > 0 && phone_number) {
      const current = (await phoneBox.first().inputValue()).trim();
      if (current === "") {
        await phoneBox.first().fill(phone_number);
      }
    }
    const uploadBtn = page.getByRole("button", { name: /^Upload resume/i });
    if ((await uploadBtn.count()) > 0) {
      await uploadBtn.first().click();
      const resumeInput = page.getByLabel(/resume/i);
      if ((await resumeInput.count()) === 0) {
        throw new Error("Upload résumé input not found after clicking button.");
      }
      await resumeInput.first().setInputFiles(resume_path);
    }
    const submitBtn = page.getByRole("button", { name: /^(Submit application|Finish|Done)$/i });
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click();
      break;
    }
    const continueBtn = page.getByRole("button", { name: /^(Continue to next step|Continue|Next|Review)$/i });
    if ((await continueBtn.count()) > 0) {
      await continueBtn.first().click();
      continue;
    }
    throw new Error("Encountered an unrecognised Easy-Apply wizard step.");
  }
  await page.waitForTimeout(1000);
  const banner = page.getByText(/application has been submitted/i);
  if ((await banner.count()) > 0) return "submitted";
  const dialogs = page.getByRole("dialog");
  if ((await dialogs.count()) === 0) return "submitted";
  throw new Error("Wizard closed without visible confirmation – state unknown.");
}

export async function dismiss_verifications_dialog(page, wait_seconds = 5.0) {
  await page.goto('/jobs/collections/recommended/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait_seconds * 1000);
  const dialogLocator = page.getByRole('dialog', { name: 'Verifications' });
  const dialogPresent = (await dialogLocator.count()) > 0;
  if (!dialogPresent) {
    return { dialog_found: false, message: 'Verifications dialog not present.' };
  }
  await dialogLocator.getByRole('button', { name: 'Dismiss' }).click();
  await dialogLocator.waitFor({ state: 'detached', timeout: 3000 });
  return { dialog_found: true, message: 'Verifications dialog dismissed.' };
}

export async function open_company_people_tab(page, company_slug) {
  await page.goto(`https://www.linkedin.com/company/${company_slug}`, { waitUntil: 'domcontentloaded' });
  const orgNav = page.getByRole('navigation', { name: 'Organization’s page navigation' });
  await orgNav.waitFor({ state: 'visible' });
  const peopleLink = orgNav.getByRole('link', { name: 'People' });
  await peopleLink.waitFor({ state: 'visible' });
  await peopleLink.click();
  const searchBox = page.getByRole('textbox', { name: 'Search employees by title, keyword or school' });
  await searchBox.waitFor({ state: 'visible' });
  const employeeItems = page.getByRole('listitem');
  await employeeItems.first().waitFor({ state: 'visible', timeout: 10000 });
  const count = await employeeItems.count();
  if (count === 0) throw new Error('People tab rendered but no employee entries were found.');
}

export async function search_and_easy_apply_job(page, job_title, resume_path, phone_number = "", location = "", apply_easy_apply_filter = true) {
  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const getJobBox = () => page.getByRole("textbox", { name: /Search jobs/i });
  await page.goto("/jobs/", { waitUntil: "load" });
  let jobBox = getJobBox();
  if ((await jobBox.count()) === 0) {
    await page.goto("/jobs/search/", { waitUntil: "load" });
    jobBox = getJobBox();
  }
  if ((await jobBox.count()) === 0) {
    throw new Error("'Search jobs' textbox not found on Jobs page (after fallback).");
  }
  await jobBox.first().fill(job_title);
  if (location) {
    const locBox = page.getByRole("textbox", { name: /Search location/i });
    if ((await locBox.count()) > 0) {
      await locBox.first().fill(location);
    }
  }
  await jobBox.first().press("Enter");
  const resultsLoaded = async () => (await page.getByRole("listitem").count()) > 0;
  for (let i = 0; i < 20; ++i) {
    if (await resultsLoaded()) break;
    await page.waitForTimeout(500);
  }
  if (!(await resultsLoaded())) throw new Error("Job search yielded no visible results – possible LinkedIn issue.");
  if (apply_easy_apply_filter) {
    const easyChip = page.getByRole("button", { name: /^Easy Apply$/i });
    if ((await easyChip.count()) > 0 && (await easyChip.first().getAttribute("aria-pressed")) !== "true") {
      await easyChip.first().click();
      await page.waitForTimeout(1000);
    }
  }
  let jobLink = page.getByRole("link", { name: job_title, exact: true });
  if ((await jobLink.count()) === 0) {
    const prefixPat = new RegExp(`^${escapeRegExp(job_title)}\\b`, "i");
    const fallback = page.getByRole("link", { name: prefixPat });
    if ((await fallback.count()) === 1) {
      jobLink = fallback;
    } else {
      throw new Error(`No unique job card found for title '${job_title}'.`);
    }
  }
  await jobLink.first().click();
  const easyApplyBtn = page.getByRole("button", { name: /^Easy Apply/i });
  if ((await easyApplyBtn.count()) === 0) {
    return "skipped";
  }
  await easyApplyBtn.first().click();
  for (let i = 0; i < 20; ++i) {
    await page.waitForTimeout(500);
    const phoneBox = page.getByRole("textbox", { name: /Mobile phone number/i });
    if ((await phoneBox.count()) > 0 && phone_number && (await phoneBox.first().inputValue()).trim() === "") {
      await phoneBox.first().fill(phone_number);
    }
    const uploadBtn = page.getByRole("button", { name: /^Upload resume/i });
    if ((await uploadBtn.count()) > 0) {
      await uploadBtn.first().click();
      const resumeInput = page.getByLabel(/resume/i);
      if ((await resumeInput.count()) === 0) throw new Error("Upload résumé input not found after clicking button.");
      const [{ existsSync }, { resolve, join }, { homedir }] = await Promise.all([
        import('node:fs'), import('node:path'), import('node:os')
      ]);
      const expandHome = (p) => p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
      const filePath = resolve(expandHome(resume_path));
      if (!existsSync(filePath)) throw new Error(`Résumé file not found: ${filePath}`);
      await resumeInput.first().setInputFiles(filePath);
    }
    const submitBtn = page.getByRole("button", { name: /^(Submit application|Finish|Done)$/i });
    if ((await submitBtn.count()) > 0) { await submitBtn.first().click(); break; }
    const continueBtn = page.getByRole("button", { name: /^(Continue to next step|Continue|Next|Review)$/i });
    if ((await continueBtn.count()) > 0) { await continueBtn.first().click(); continue; }
    throw new Error("Encountered an unrecognised Easy-Apply wizard step.");
  }
  await page.waitForTimeout(1000);
  const banner = page.getByText(/application has been submitted/i);
  if ((await banner.count()) > 0) return "submitted";
  const dialogs = page.getByRole("dialog");
  if ((await dialogs.count()) === 0) return "submitted";
  throw new Error("Wizard closed without visible confirmation – state unknown.");
}

export async function search_and_bookmark_top_jobs(page, job_title, location, num_jobs = 3, apply_easy_apply_filter = true) {
  const saved_jobs = [];
  await page.goto('/jobs/');
  let title_input = null;
  const title_candidates = [
    page.getByRole('combobox', { name: /title|company/i }),
    page.getByPlaceholder(/title/i)
  ];
  for (const cand of title_candidates) { if ((await cand.count()) > 0) { title_input = cand.first(); break; } }
  if (title_input === null) throw new Error('Job-title search box not found on /jobs/ page.');
  await title_input.click();
  await title_input.press('Control+A');
  await title_input.press('Delete');
  await title_input.fill(job_title);
  if (location) {
    let location_input = null;
    const loc_candidates = [
      page.getByRole('combobox', { name: /location|city/i }),
      page.getByPlaceholder(/city|state|zip/i)
    ];
    for (const cand of loc_candidates) { if ((await cand.count()) > 0) { location_input = cand.first(); break; } }
    if (location_input === null) throw new Error('Location search box not found on /jobs/ page.');
    await location_input.click();
    await location_input.press('Control+A');
    await location_input.press('Delete');
    await location_input.fill(location);
  }
  await title_input.press('Enter');
  const main_region = page.getByRole('main');
  if ((await main_region.getByRole('listitem').count()) === 0) {
    await main_region.getByRole('listitem').first().waitFor({ state: 'visible', timeout: 10000 });
  }
  if ((await main_region.getByRole('listitem').count()) === 0) throw new Error('No job-search results found after submitting query.');
  if (apply_easy_apply_filter) {
    const easy_apply_pill = page.getByRole('button', { name: /Easy Apply/i });
    if ((await easy_apply_pill.count()) > 0) {
      const pill = easy_apply_pill.first();
      if ((await pill.getAttribute('aria-pressed')) !== 'true') {
        await pill.click();
        await main_region.getByRole('listitem').first().waitFor({ state: 'visible' });
      }
    }
  }
  const job_cards = main_region.getByRole('listitem');
  const total_cards = await job_cards.count();
  const limit = Math.min(num_jobs, total_cards);
  if (limit === 0) throw new Error('No job cards available to bookmark.');
  for (let idx = 0; idx < limit; idx++) {
    const card = job_cards.nth(idx);
    const card_link = card.getByRole('link').first();
    let card_title = await card_link.getAttribute('aria-label');
    if (!card_title) { const innerText = await card_link.innerText(); card_title = innerText.split('\n')[0].trim(); }
    await card.click();
    const save_button = page.getByRole('button', { name: /^(Save|Saved)/i }).first();
    await save_button.waitFor({ state: 'visible' });
    const button_text = (await save_button.innerText()).trim().toLowerCase();
    if (button_text.startsWith('save')) { await save_button.click(); }
    saved_jobs.push(card_title);
  }
  return { success: true, saved_jobs };
}

export async function open_pranav_linkedin(page) {
  await page.goto('https://www.linkedin.com/in/pranav-madhukar-pcm/');
  await page.waitForLoadState('domcontentloaded');
  return { success: true, message: "Opened Pranav's LinkedIn profile" };
}


