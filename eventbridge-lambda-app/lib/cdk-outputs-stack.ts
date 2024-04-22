import * as cdk from 'aws-cdk-lib';
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from 'constructs';
import { ImportedRDSCluster } from './imported-rds-cluster';

export class OutputsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
      super(scope, id, props);
      
      // Get environment to work with, variables are specified in cdk.json
      const env = process.env.CDK_ENV || "dev";
      const context = this.node.tryGetContext(env);

      // RDS account and region
      const accountID = context.RDS_ACCOUNT_ID;
      const region = context.RDS_REGION;
      
      const rdsDbUser = context.RDS_DB_USER;
      const rdsClusterID = context.RDS_CLUSTER_ID;

      // Existing RDS Cluster to get info from
      const existingRdsCluster = new ImportedRDSCluster(this, 'existingRDS', {
        TargetRegion: region, 
        TargetAccount: accountID,
        DBClusterIdentifier: rdsClusterID
      });

      // SSM parameters to hold exported values
      // Needed for values that are required at synth time
      new ssm.StringParameter(this, "vpcIdString", {
        parameterName: "/ssotordssync/rdsVpcId",
        stringValue: existingRdsCluster.vpc
      });

      new ssm.StringParameter(this, "rdsDBPortString", {
        parameterName: "/ssotordssync/rdsDBPort",
        stringValue: existingRdsCluster.port
      });

      new ssm.StringParameter(this, "rdsLambdaDBUser", {
        parameterName: "/ssotordssync/rdsLambdaDBUser",
        stringValue: rdsDbUser
      });

      // Cfn outputs to hold exported values
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