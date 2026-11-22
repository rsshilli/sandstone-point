import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SiteStack } from '../lib/site-stack';

const env = { account: '692580093266', region: 'us-east-1' };

/**
 * Synthesizes the stack into a CloudFormation template for assertions.
 * @param domainName optional domain to configure
 * @returns the synthesized template
 */
function synth(domainName?: string): Template {
  const app = new cdk.App();
  if (domainName) {
    // Pre-seed the Route 53 lookup so the test never calls AWS.
    app.node.setContext(
      `hosted-zone:account=${env.account}:domainName=${domainName}:region=${env.region}`,
      { Id: '/hostedzone/Z123TEST', Name: `${domainName}.` },
    );
  }
  return Template.fromStack(new SiteStack(app, 'Test', { env, domainName }));
}

describe('SiteStack', () => {
  it('should keep the site bucket fully private', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  it('should serve over HTTPS with index.html as the home page and no domain when none is given', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        Aliases: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('should add a certificate, aliases and DNS records for the apex and www when a domain is given', () => {
    const template = synth('example-hoa.org');
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'example-hoa.org',
      SubjectAlternativeNames: ['www.example-hoa.org'],
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['example-hoa.org', 'www.example-hoa.org'] }),
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 4);
  });

  it('should create an owner pool where people sign up with a verified email, kept on stack deletion', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
      DeletionProtection: 'ACTIVE',
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 10 }) },
    });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  it('should send /api/* to the portal API uncached, with the visitor\'s headers', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // Managed-AllViewerExceptHostHeader
            AllowedMethods: Match.arrayWith(['POST']),
          }),
        ],
      }),
    });
  });

  it('should give the API Lambda only read access to the Google secret, and its pool settings', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: Match.objectLike({ GOOGLE_SECRET_ID: 'sandstone-point/google-sheets', USER_POOL_ID: Match.anyValue(), CLIENT_ID: Match.anyValue() }) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            Resource: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(':secret:sandstone-point/google-sheets-\\?\\?\\?\\?\\?\\?$')])]) }),
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});
