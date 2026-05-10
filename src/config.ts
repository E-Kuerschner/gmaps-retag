export const isDryRun = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';

if (isDryRun) {
  console.log('[config] DRY RUN mode enabled — selector navigation will run but no Maps changes will be written');
}
