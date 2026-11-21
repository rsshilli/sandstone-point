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

/** Options for {@link SiteStack}. */
export interface SiteStackProps extends cdk.StackProps {
  /**
   * The HOA's domain (e.g. `sandstonepointhoa.org`), registered in Route 53 in this account.
   * When omitted the site is served only on CloudFront's `*.cloudfront.net` address.
   */
  domainName?: string;
}

/**
 * The public HOA website: a private S3 bucket holding the files in `site/`, served over HTTPS by
 * CloudFront. When a domain is given, it also issues the certificate and points the domain (and
 * `www.`) at CloudFront.
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
    this.distribution = this.createDistribution(bucket, domain);
    if (domain) {
      this.createDnsRecords(domain.zone, this.distribution);
    }
    this.uploadSite(bucket, this.distribution);

    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${this.distribution.distributionDomainName}` });
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
   * Creates the CloudFront distribution in front of the bucket, with standard security headers and
   * a friendly 404 page.
   * @param bucket the site bucket
   * @param domain the domain pieces, when a domain is configured
   * @returns the distribution
   */
  private createDistribution(
    bucket: s3.IBucket,
    domain?: { certificate: acm.ICertificate; names: string[] },
  ): cloudfront.Distribution {
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
   * Uploads `site/` to the bucket on every deploy and clears CloudFront's cache so changes show.
   * @param bucket the site bucket
   * @param distribution the distribution to invalidate
   */
  private uploadSite(bucket: s3.IBucket, distribution: cloudfront.IDistribution): void {
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });
  }
}
