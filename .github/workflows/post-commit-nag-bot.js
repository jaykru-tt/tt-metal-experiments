module.exports = async ({ github, context }) => {
  const defaultWorkflow = 'Dummy Test Workflow'; // Default workflow name
  const defaultWorkflowFile = 'dummy-test.yml'; // Default workflow file
  const overrideCmd    = '/override';
  const runWorkflowCmd = '/run';

  console.log(`🤖 Post-commit nag bot triggered by: ${context.eventName}`);

  // State storage using PR body
  async function getTrackedWorkflows(prNumber) {
    const { data: pr } = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber
    });

    // Extract tracked workflows from PR body
    const match = pr.body && pr.body.match(/<!-- NAG-BOT-TRACKED-WORKFLOWS: (.+?) -->/);
    if (match) {
      try {
        return JSON.parse(decodeURIComponent(match[1]));
      } catch (e) {
        console.error('Failed to parse tracked workflows:', e);
      }
    }

    // Default to the configured workflow
    return [{
      name: defaultWorkflow,
      file: defaultWorkflowFile
    }];
  }

  async function updateTrackedWorkflows(prNumber, workflows) {
    const { data: pr } = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber
    });

    const encoded = encodeURIComponent(JSON.stringify(workflows));
    const marker = `<!-- NAG-BOT-TRACKED-WORKFLOWS: ${encoded} -->`;

    let newBody = pr.body || '';
    if (newBody.includes('<!-- NAG-BOT-TRACKED-WORKFLOWS:')) {
      newBody = newBody.replace(/<!-- NAG-BOT-TRACKED-WORKFLOWS: .+? -->/, marker);
    } else {
      newBody = newBody + '\n\n' + marker;
    }

    await github.rest.pulls.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      body: newBody
    });
  }

  /* -------- helpers -------- */

  // locate (or create) the single bot comment for this PR
  async function upsertComment(prNumber, body) {
    console.log(`📝 Updating comment for PR #${prNumber}`);
    const comments = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo:  context.repo.repo,
      issue_number: prNumber
    });

    const existing = comments.data.find(
      c => c.user.login === 'github-actions[bot]' &&
           (c.body.startsWith('**⛔️') || c.body.startsWith('**✅') || c.body.startsWith('**⚠️'))
    );

    if (existing) {
      console.log(`🗑️ Deleting old comment (ID: ${existing.id}) to move to bottom`);
      await github.rest.issues.deleteComment({
        owner: context.repo.owner,
        repo:  context.repo.repo,
        comment_id: existing.id
      });

      console.log(`📌 Creating new comment at bottom`);
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo:  context.repo.repo,
        issue_number: prNumber,
        body
      });
    } else {
      console.log(`📌 Creating new comment`);
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo:  context.repo.repo,
        issue_number: prNumber,
        body
      });
    }
  }

  // Check workflow status for a specific workflow
  async function checkWorkflowStatus(pr, workflowName) {
    const runs = await github.rest.actions.listWorkflowRunsForRepo({
      owner: context.repo.owner,
      repo:  context.repo.repo,
      branch: pr.head.ref,
      per_page: 100
    });

    // Find all runs for this workflow on this branch
    const workflowRuns = runs.data.workflow_runs.filter(r => r.name === workflowName);

    // Check if run on HEAD
    const headRun = workflowRuns.find(r => r.head_sha === pr.head.sha && r.status === 'completed' && r.conclusion === 'success');
    if (headRun) {
      return { status: 'success', commit: 'HEAD' };
    }

    // Check if run on older commits
    const successfulRun = workflowRuns.find(r => r.status === 'completed' && r.conclusion === 'success');
    if (successfulRun) {
      // Try to determine how many commits behind
      try {
        const commits = await github.rest.pulls.listCommits({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number,
          per_page: 100
        });

        const headIndex = commits.data.findIndex(c => c.sha === pr.head.sha);
        const runIndex = commits.data.findIndex(c => c.sha === successfulRun.head_sha);

        if (headIndex !== -1 && runIndex !== -1) {
          const distance = runIndex - headIndex;
          return { status: 'warning', commit: `HEAD~${distance}`, sha: successfulRun.head_sha.substring(0, 7) };
        }
      } catch (e) {
        console.error('Failed to determine commit distance:', e);
      }

      return { status: 'warning', commit: 'older commit', sha: successfulRun.head_sha.substring(0, 7) };
    }

    return { status: 'failed' };
  }

  // Dispatch a workflow
  async function dispatchWorkflow(prNumber, workflowFile) {
    const { data: pr } = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo:  context.repo.repo,
      pull_number: prNumber
    });

    try {
      console.log(`🎯 Dispatching workflow ${workflowFile} for PR #${prNumber} on ref: ${pr.head.ref}`);

      // Get the workflow info first
      const workflowInfo = await github.rest.actions.getWorkflow({
        owner: context.repo.owner,
        repo: context.repo.repo,
        workflow_id: workflowFile
      });
      const workflowId = workflowInfo.data.id;
      const workflowName = workflowInfo.data.name;
      console.log(`📋 Workflow ID: ${workflowId}, Name: ${workflowName}`);

      // Check if workflow has workflow_dispatch trigger
      if (!workflowInfo.data.path.includes('workflow_dispatch')) {
        throw new Error(`Workflow ${workflowFile} does not have workflow_dispatch trigger`);
      }

      // Dispatch the workflow
      await github.rest.actions.createWorkflowDispatch({
        owner: context.repo.owner,
        repo: context.repo.repo,
        workflow_id: workflowId,
        ref: pr.head.ref
      });

      console.log(`✅ Workflow dispatched successfully, polling for run URL...`);

      // Poll for the new run (for up to 15 seconds)
      let workflowRunUrl = null;
      const maxAttempts = 15;

      for (let i = 0; i < maxAttempts; i++) {
        // Wait a bit before checking (first attempt is immediate)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const runs = await github.rest.actions.listWorkflowRunsForRepo({
          owner: context.repo.owner,
          repo: context.repo.repo,
          branch: pr.head.ref,
          per_page: 10
        });

        // Find a run that was created in the last 30 seconds
        const now = new Date();
        for (const run of runs.data.workflow_runs) {
          if (run.workflow_id === workflowId) {
            const createdAt = new Date(run.created_at);
            const secondsAgo = (now - createdAt) / 1000;

            if (secondsAgo < 30) {
              workflowRunUrl = run.html_url;
              console.log(`🎯 Found workflow run: ${workflowRunUrl}`);
              break;
            }
          }
        }

        if (workflowRunUrl) break;
      }

      // Update tracked workflows
      const trackedWorkflows = await getTrackedWorkflows(prNumber);
      const exists = trackedWorkflows.find(w => w.file === workflowFile);
      if (!exists) {
        trackedWorkflows.push({ name: workflowName, file: workflowFile });
        await updateTrackedWorkflows(prNumber, trackedWorkflows);
      }

      // Create comment with direct link or fallback to filtered page
      if (workflowRunUrl) {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: `🔄 Running \`${workflowName}\` on the latest commit (${pr.head.sha.substring(0, 7)}). [View run](${workflowRunUrl})`
        });
      } else {
        // Fallback to filtered page if we couldn't find the run
        const workflowRunLink = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/workflows/${workflowFile}?query=branch%3A${encodeURIComponent(pr.head.ref)}`;
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: `🔄 Running \`${workflowName}\` on the latest commit (${pr.head.sha.substring(0, 7)}). [View progress](${workflowRunLink})`
        });
      }

      return { success: true, workflowName };
    } catch (dispatchError) {
      console.error("❌ Error dispatching workflow:", dispatchError);
      await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: `⚠️ Failed to trigger workflow \`${workflowFile}\`. Error: ${dispatchError.message}`
        });
      return { success: false, error: dispatchError.message };
    }
  }

  /* -------- router -------- */

  let prNumber, forceGreen = false;

  if (context.eventName === 'pull_request') {
    prNumber = context.payload.pull_request.number;
    console.log(`🔍 Processing PR #${prNumber} event: ${context.payload.action}`);

  } else if (context.eventName === 'workflow_run') {
    const run = context.payload.workflow_run;
    console.log(`🏃 Processing workflow run: ${run.name} (${run.conclusion})`);

    // Find PRs for this branch
    const prs = await github.rest.pulls.list({
      owner: context.repo.owner,
      repo:  context.repo.repo,
      head:  `${context.repo.owner}:${run.head_branch}`
    });

    if (!prs.data.length) {
      console.log(`⏭️ No open PRs found for branch: ${run.head_branch}`);
      return;
    }

    // Check if this workflow is tracked for any PR
    for (const pr of prs.data) {
      const trackedWorkflows = await getTrackedWorkflows(pr.number);
      const isTracked = trackedWorkflows.some(w => w.name === run.name);

      if (isTracked && run.conclusion === 'success') {
        prNumber = pr.number;
        console.log(`✅ Found tracked workflow ${run.name} for PR #${prNumber}`);
        break;
      }
    }

    if (!prNumber) {
      console.log(`⏭️ Workflow ${run.name} is not tracked for any PR`);
      return;
    }

  } else if (context.eventName === 'issue_comment') {
    if (!context.payload.issue.pull_request) {
      console.log(`⏭️ Comment is not on a PR, ignoring`);
      return;
    }

    const commentBody = context.payload.comment.body;
    console.log(`💬 Processing comment by ${context.payload.comment.user.login}`);

    if (commentBody.includes(overrideCmd)) {
      console.log(`🟢 Override command detected!`);
      prNumber   = context.payload.issue.number;
      forceGreen = true;
    } else if (commentBody.includes(runWorkflowCmd)) {
      console.log(`🚀 Run workflow command detected!`);
      prNumber = context.payload.issue.number;

      // Parse workflow file from comment
      const match = commentBody.match(/\/run\s+(\S+\.ya?ml)/);
      const workflowFile = match ? match[1] : defaultWorkflowFile;

      const result = await dispatchWorkflow(prNumber, workflowFile);
      if (result.success) {
        // Continue to update status after dispatching
      } else {
        return; // Exit on error
      }
    } else {
      console.log(`⏭️ Ignoring comment - no recognized commands`);
      return; // Ignore other comments
    }

  } else {
    console.log(`⏭️ Ignoring event: ${context.eventName}`);
    return;   // ignore other events
  }

  /* -------- main logic -------- */

  console.log(`🔎 Checking PR #${prNumber} status...`);
  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo:  context.repo.repo,
    pull_number: prNumber
  });

  if (forceGreen) {
    console.log(`✅ Force green via override command`);
    await upsertComment(prNumber, `**✅🎉 All workflow checks overridden! You're clear to merge. 🎉✅**`);
    return;
  }

  // Check status of all tracked workflows
  const trackedWorkflows = await getTrackedWorkflows(prNumber);
  const workflowStatuses = [];

  for (const workflow of trackedWorkflows) {
    const status = await checkWorkflowStatus(pr, workflow.name);
    workflowStatuses.push({ ...workflow, ...status });
  }

  // Determine overall status
  const failedWorkflows = workflowStatuses.filter(w => w.status === 'failed');
  const warningWorkflows = workflowStatuses.filter(w => w.status === 'warning');
  const allSuccess = workflowStatuses.every(w => w.status === 'success');

  let body;
  if (allSuccess) {
    const workflowList = trackedWorkflows.map(w => `\`${w.name}\``).join(', ');
    body = `**✅🎉 All tracked workflows (${workflowList}) have run successfully on the latest commit! You're clear to merge. 🎉✅**`;
    body += `\n\n**Commands:**\n`;
    body += `• \`${runWorkflowCmd}\` - Run the default workflow (\`${defaultWorkflowFile}\`)\n`;
    body += `• \`${runWorkflowCmd} workflow.yml\` - Run a specific workflow\n`;
    body += `• \`${overrideCmd}\` - Override all workflow checks`;
  } else if (failedWorkflows.length > 0) {
    body = `**⛔️🚨 The following workflows have NOT run on the latest commit: 🚨⛔️**\n\n`;
    for (const workflow of failedWorkflows) {
      body += `❌ \`${workflow.name}\` - Not run on HEAD\n`;
    }
    for (const workflow of warningWorkflows) {
      body += `⚠️ \`${workflow.name}\` - Last successful run on ${workflow.commit} (${workflow.sha})\n`;
    }
    body += `\n**Commands:**\n`;
    body += `• \`${runWorkflowCmd}\` - Run the default workflow (\`${defaultWorkflowFile}\`)\n`;
    body += `• \`${runWorkflowCmd} workflow.yml\` - Run a specific workflow\n`;
    body += `• \`${overrideCmd}\` - Override all workflow checks`;
  } else {
    // Only warnings
    body = `**⚠️ Some workflows need to be re-run on the latest commit: ⚠️**\n\n`;
    for (const workflow of warningWorkflows) {
      body += `⚠️ \`${workflow.name}\` - Last successful run on ${workflow.commit} (${workflow.sha})\n`;
    }
    body += `\n**Commands:**\n`;
    body += `• \`${runWorkflowCmd}\` - Run the default workflow (\`${defaultWorkflowFile}\`)\n`;
    body += `• \`${runWorkflowCmd} workflow.yml\` - Run a specific workflow\n`;
    body += `• \`${overrideCmd}\` - Override all workflow checks`;
  }

  await upsertComment(prNumber, body);
  console.log(`📊 Status check complete. Failed: ${failedWorkflows.length}, Warning: ${warningWorkflows.length}, Success: ${workflowStatuses.length - failedWorkflows.length - warningWorkflows.length}`);
};
