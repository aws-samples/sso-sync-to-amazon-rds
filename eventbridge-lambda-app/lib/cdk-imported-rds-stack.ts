import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ImportedRDSCluster } from './imported-rds-cluster';

export class ExistingRDSCluster extends cdk.Stack {
    constructor(scope: Construct, id: string) {
      super(scope, id);
      
      // Get environment to work with, variables are specified in cdk.json
      const env = process.env.CDK_ENV || "dev";
      const context = this.node.tryGetContext(env);

      const accountID = cdk.Stack.of(this).account;
      const region = cdk.Stack.of(this).region;
      const rdsClusterID = context.RDS_CLUSTER_ID;
      const rdsAccountID = context.RDS_ACCOUNT_ID || accountID;

      // Existing RDS Cluster to get info from
      const existingRdsCluster = new ImportedRDSCluster(this, 'existingRDS', {
        TargetRegion: region, 
        TargetAccount: rdsAccountID,
        DBClusterIdentifier: rdsClusterID
      });

      new cdk.CfnOutput(this, 'rdsClusterEPAddr', {
        value: existingRdsCluster.endpoint,
        exportName: 'rdsClusterEPAddr'
      });

      new cdk.CfnOutput(this, 'dbSgID', {
        value: existingRdsCluster.vpcSgId,
        exportName: 'dbSgID'
      });

      new cdk.CfnOutput(this, 'rdsDBPort', {
        value: existingRdsCluster.port,
        exportName: 'rdsDBPort'
      });

      new cdk.CfnOutput(this, 'rdsVpcID', {
        value: existingRdsCluster.vpc,
        exportName: 'rdsVpcID'
      });

      new cdk.CfnOutput(this, 'rdsEngine', {
        value: existingRdsCluster.engine,
        exportName: 'rdsEngine'
      });

    }


}