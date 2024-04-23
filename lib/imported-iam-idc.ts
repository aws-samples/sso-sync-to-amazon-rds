import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface ImportedIamIdcProps {
    readonly TargetRegion: string;
  }

interface ImportedIamIdcGroupProps {
    readonly TargetRegion: string;
    readonly TargetIDC: string;
    readonly GroupName: string;
  }

export class ImportedIamIdc extends Construct {
    public readonly idcID: string;

    constructor(scope: Construct, id: string, props: ImportedIamIdcProps) {
        super(scope, id);

        const idc = new cr.AwsCustomResource(this, 'importedIamIdc', {
            onUpdate: {
                service: 'SSOAdmin',
                action: 'listInstances',
                region: props.TargetRegion,
                physicalResourceId: cr.PhysicalResourceId.fromResponse('Instances.0.InstanceArn')
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements(
                [new PolicyStatement({
                    actions: ['SSO:ListInstances'],
                    resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
                })]
            )
        });

        this.idcID = idc.getResponseField('Instances.0.IdentityStoreId');
    }
}

export class ImportedIamIdcGroup extends Construct {
    public readonly groupID: string;

    constructor(scope: Construct, id: string, props: ImportedIamIdcGroupProps) {
        super(scope, id);

        const attributePath = 'DisplayName';
        const idcGroup = new cr.AwsCustomResource(this, 'importedIamIdcGroup', {
            onUpdate: {
                service: 'IdentityStore',
                action: 'listGroups',
                region: props.TargetRegion,
                parameters: {
                    Filters: [{
                        AttributePath: attributePath,
                        AttributeValue: props.GroupName
                    }],
                    IdentityStoreId: props.TargetIDC,
                    MaxResults: 1
                },
                physicalResourceId: cr.PhysicalResourceId.fromResponse('Groups.0.GroupId')
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
            })
        });

        this.groupID = idcGroup.getResponseField('Groups.0.GroupId');
    }
}