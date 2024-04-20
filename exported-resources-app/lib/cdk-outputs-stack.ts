import * as cdk from 'aws-cdk-lib';
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from 'constructs';
import { ImportedRDSCluster } from './imported-rds-cluster';
import { ImportedIamIdc, ImportedIamIdcGroup } from './imported-iam-idc';

export class OutputsStack extends cdk.Stack {
    constructor(scope: Construct, id: string) {
      super(scope, id);
      
      // Get environment to work with, variables are specified in cdk.json
      const env = process.env.CDK_ENV || "dev";
      const context = this.node.tryGetContext(env);

      const accountID = cdk.Stack.of(this).account;
      const region = cdk.Stack.of(this).region;
      const rdsAccountID = context.RDS_ACCOUNT_ID || accountID;
      const rdsRegion = context.RDS_REGION || region;
      
      const rdsDbUser = context.RDS_DB_USER;
      const rdsClusterID = context.RDS_CLUSTER_ID;

      // Existing RDS Cluster to get info from
      const existingRdsCluster = new ImportedRDSCluster(this, 'existingRDS', {
        TargetRegion: rdsRegion, 
        TargetAccount: rdsAccountID,
        DBClusterIdentifier: rdsClusterID
      });

      // Specify comma separated list of groups or just a single group
      const groupNames = context.IAM_IDC_GROUP_NAMES.split(",");

      // Get IAM IdC Store ID
      const identityStoreID = new ImportedIamIdc(this, 'importedIdc', { TargetRegion: region }).idcID;

      // Empty object for group membership data
      let groups: { [groupID: string] : string } = {};
      let groupIDs: string[] = [];

      // Get data for each configured group name
      for (let groupName of groupNames) {
            // Existing Group ID to check against when adding new user to RDS (ex.: DBA group)
            const groupID = new ImportedIamIdcGroup(this, 'iamIdcGroupId' + groupName, {
              TargetRegion: region, 
              TargetIDC: identityStoreID,
              GroupName: groupName
            }).groupID;

            // Populate group objects
            groups[groupID] = groupName;
            groupIDs.push(groupID);
      }

      // SSM parameters to hold exported values
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

      new cdk.CfnOutput(this, 'iamIdcId', {
        value: identityStoreID,
        exportName: 'iamIdcId'
      });

      new cdk.CfnOutput(this, 'iamIdcGroupIDs', {
        value: groupIDs.join(','),
        exportName: 'iamIdcGroupIDs'
      });

      new cdk.CfnOutput(this, 'iamIdcGroups', {
        value: JSON.stringify(groups),
        exportName: 'iamIdcGroups'
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