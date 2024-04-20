import * as cdk from 'aws-cdk-lib';
import { ArnFormat } from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface ImportedRDSClusterProps {
    readonly DBClusterIdentifier: string;
    readonly TargetRegion: string;
    readonly TargetAccount: string;
  }

export class ImportedRDSCluster extends Construct {
    public readonly endpoint: string;
    public readonly vpcSgId: string;
    public readonly port: string;
    public readonly engine: string;
    public readonly vpc: string;
    public readonly vpcAZs: any;
    
    constructor(scope: Construct, id: string, props: ImportedRDSClusterProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);
        const dbClusterArn = stack.formatArn({
          account: props.TargetAccount,
          region: props.TargetRegion,
          service: 'rds',
          resource: 'cluster',
          resourceName: '*',
          arnFormat: ArnFormat.COLON_RESOURCE_NAME
        });
        const dbInstanceArn = stack.formatArn({
            account: props.TargetAccount,
            region: props.TargetRegion,
            service: 'rds',
            resource: 'instance',
            resourceName: '*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME
          });

        const cluster = new cr.AwsCustomResource(this, 'importedRDS', {
            onUpdate: {
                service: 'RDS',
                action: 'describeDBClusters',
                parameters: {
                    DBClusterIdentifier: props.DBClusterIdentifier
                },
                region: props.TargetRegion,
                physicalResourceId: cr.PhysicalResourceId.fromResponse('DBClusters.0.DbClusterResourceId')
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [dbClusterArn]
            })
        });

        const instance = new cr.AwsCustomResource(this, 'importedRDSi', {
            onUpdate: {
                service: 'RDS',
                action: 'describeDBInstances',
                parameters: {
                    DBClusterIdentifier: cluster.getResponseField('DBClusters.0.DBClusterMembers.0.DBInstanceIdentifier')
                },
                region: props.TargetRegion,
                physicalResourceId: cr.PhysicalResourceId.fromResponse('DBInstances.0.DBInstanceIdentifier')
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [dbInstanceArn]
            })
        });

        this.vpc = instance.getResponseField('DBInstances.0.DBSubnetGroup.VpcId');
        this.vpcAZs = cluster.getResponseField('DBClusters.0.AvailabilityZones');
        this.endpoint = cluster.getResponseField('DBClusters.0.Endpoint');
        this.vpcSgId = cluster.getResponseField('DBClusters.0.VpcSecurityGroups.0.VpcSecurityGroupId');
        this.port = cluster.getResponseField('DBClusters.0.Port');
        this.engine = cluster.getResponseField('DBClusters.0.Engine');
    }
}