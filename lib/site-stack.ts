import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Secrets Manager secret holding `{spreadsheetId, client_email, private_key}` for the owner
 * records sheet. Created by hand (see .github/GOOGLE_SERVICE_ACCOUNT_SETUP.md), not by this stack,
 * so the key never passes through CloudFormation.
 */
export const GOOGLE_SECRET_NAME = 'sandstone-point/google-sheets';

/** The owner-login pieces the distribution and the upload need. */
interface Portal {
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
  api: apigw.HttpApi;
}

/** Options for {@link SiteStack}. */
export interface SiteStackProps extends cdk.StackProps {
  /**
   * The HOA's domain (e.g. `sandstonepointhoa.org`), registered in Route 53 in this account.
   * When omitted the site is served only on CloudFront's `*.cloudfront.net` address.
   */
  domainName?: string;
}

/**
 * The HOA website: a private S3 bucket holding the files in `site/`, served over HTTPS by
 * CloudFront, plus the owner login (a Cognito user pool, and a Lambda behind `/api/*` that reads
 * the owner records sheet). When a domain is given, it also issues the certificate and points the
 * domain (and `www.`) at CloudFront.
 */
export class SiteStack extends cdk.Stack {
  /** The CloudFront distribution serving the site. */
  public readonly distribution: cloudfront.Distribution;

  /**
   * Builds the bucket, the optional domain pieces, the distribution and the file upload.
   * @param scope parent construct (the CDK app)
   * @param id stack id
   * @param props stack options, including the optional domain
   */
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const bucket = this.createBucket();
    const domain = props.domainName ? this.createDomain(props.domainName) : undefined;
    const portal = this.createPortal();
    this.distribution = this.createDistribution(bucket, portal.api, domain);
    if (domain) {
      this.createDnsRecords(domain.zone, this.distribution);
    }
    this.uploadSite(bucket, this.distribution, portal);

    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'UserPoolId', { value: portal.userPool.userPoolId });
    if (props.domainName) {
      new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${props.domainName}` });
    }
  }

  /**
   * Creates the private bucket for the site files. Only CloudFront can read it.
   * @returns the bucket
   */
  private createBucket(): s3.Bucket {
    return new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /**
   * Looks up the domain's Route 53 zone and issues a DNS-validated certificate for the domain and
   * `www.` (CloudFront needs it in us-east-1, which is where this stack lives).
   * @param domainName the registered domain
   * @returns the zone, certificate and the host names to serve
   */
  private createDomain(domainName: string): { zone: route53.IHostedZone; certificate: acm.ICertificate; names: string[] } {
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName });
    const names = [domainName, `www.${domainName}`];
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      subjectAlternativeNames: [names[1]],
      validation: acm.CertificateValidation.fromDns(zone),
    });
    return { zone, certificate, names };
  }

  /**
   * Creates the owner login: a Cognito user pool where anyone can make an account with a
   * verified email, the web app client the login page uses, and the `/api/*` Lambda (behind an
   * HTTP API) that checks the sign-in and reads the owner records sheet.
   * @returns the pool, its client and the API
   */
  private createPortal(): Portal {
    const userPool = new cognito.UserPool(this, 'OwnerPool', {
      userPoolName: 'sandstone-point-owners',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // An email change only takes effect once the new address is verified, so nobody can claim
      // another owner's email by editing their profile.
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 10, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: 'Your Sandstone Point sign-up code',
        emailBody: 'Your Sandstone Point owner login code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const client = userPool.addClient('WebClient', {
      userPoolClientName: 'website',
      authFlows: { userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });

    const secret = secretsmanager.Secret.fromSecretNameV2(this, 'GoogleSheetSecret', GOOGLE_SECRET_NAME);
    const handler = new nodejs.NodejsFunction(this, 'PortalApi', {
      entry: path.join(__dirname, 'portal', 'lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: { USER_POOL_ID: userPool.userPoolId, CLIENT_ID: client.userPoolClientId, GOOGLE_SECRET_ID: GOOGLE_SECRET_NAME },
      logGroup: new logs.LogGroup(this, 'PortalApiLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });
    secret.grantRead(handler);

    const api = new apigw.HttpApi(this, 'PortalHttpApi', {
      description: 'Sandstone Point owner portal API (reached through CloudFront at /api/*)',
      defaultIntegration: new HttpLambdaIntegration('PortalIntegration', handler),
    });
    // Slow down anyone hammering the API; a neighbourhood needs a handful of requests a second.
    const stage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    return { userPool, client, api };
  }

  /**
   * Creates the CloudFront distribution in front of the bucket, with standard security headers and
   * a friendly 404 page. `/api/*` goes to the portal API, uncached, with the Authorization header.
   * @param bucket the site bucket
   * @param api the portal API
   * @param domain the domain pieces, when a domain is configured
   * @returns the distribution
   */
  private createDistribution(
    bucket: s3.IBucket,
    api: apigw.HttpApi,
    domain?: { certificate: acm.ICertificate; names: string[] },
  ): cloudfront.Distribution {
    const apiOrigin = new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`);
    return new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Sandstone Point HOA website',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      domainNames: domain?.names,
      certificate: domain?.certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
      errorResponses: [
        // S3 answers 403 for a missing object when the bucket can't be listed.
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
      ],
    });
  }

  /**
   * Points the domain and `www.` at CloudFront (IPv4 and IPv6 alias records).
   * @param zone the domain's hosted zone
   * @param distribution the distribution to point at
   */
  private createDnsRecords(zone: route53.IHostedZone, distribution: cloudfront.IDistribution): void {
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    for (const [id, recordName] of [['Apex', undefined], ['Www', 'www']] as const) {
      new route53.ARecord(this, `${id}A`, { zone, recordName, target });
      new route53.AaaaRecord(this, `${id}Aaaa`, { zone, recordName, target });
    }
  }

  /**
   * Uploads `site/` to the bucket on every deploy, plus `config.json` telling the login page which
   * Cognito pool and client to use, and clears CloudFront's cache so changes show.
   * @param bucket the site bucket
   * @param distribution the distribution to invalidate
   * @param portal the user pool and client for config.json
   */
  private uploadSite(bucket: s3.IBucket, distribution: cloudfront.IDistribution, portal: Portal): void {
    const loginConfig = {
      region: this.region,
      userPoolId: portal.userPool.userPoolId,
      clientId: portal.client.userPoolClientId,
      cognitoEndpoint: `https://cognito-idp.${this.region}.amazonaws.com/`,
    };
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site')), s3deploy.Source.jsonData('config.json', loginConfig)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });
  }
}
