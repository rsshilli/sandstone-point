import * as cdk from 'aws-cdk-lib';
import { SiteStack } from '../lib/site-stack';

/**
 * CDK entry point. Reads the target account, region and (optional) domain from cdk.json context
 * and creates the public website stack. Leave `domainName` empty to serve on CloudFront's own
 * address until the HOA domain is registered.
 */
function main(): void {
  const app = new cdk.App();
  const account = app.node.tryGetContext('account') as string;
  const region = app.node.tryGetContext('region') as string;
  const domainName = (app.node.tryGetContext('domainName') as string | undefined) || undefined;

  new SiteStack(app, 'SandstonePointSite', {
    env: { account, region },
    domainName,
    description: 'Sandstone Point HOA public website (S3 + CloudFront)',
  });
}

main();
