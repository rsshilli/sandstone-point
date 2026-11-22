import * as cdk from 'aws-cdk-lib';
import { SiteStack } from '../lib/site-stack';

/**
 * CDK entry point. Reads the target account, region and (optional) domain from cdk.json context
 * and creates the public website stack. Leave `domainName` empty to serve on CloudFront's own
 * address until the HOA domain is registered. `boardMessages` turns on the owners' "Message the
 * board" form; it needs the domain and SES able to deliver (see SiteStackProps).
 */
function main(): void {
  const app = new cdk.App();
  const account = app.node.tryGetContext('account') as string;
  const region = app.node.tryGetContext('region') as string;
  const domainName = (app.node.tryGetContext('domainName') as string | undefined) || undefined;
  // `-c boardMessages=true` on the command line arrives as a string.
  const boardMessages = String(app.node.tryGetContext('boardMessages')) === 'true';

  new SiteStack(app, 'SandstonePointSite', {
    env: { account, region },
    domainName,
    boardMessages,
    description: 'Sandstone Point HOA public website (S3 + CloudFront)',
  });
}

main();
