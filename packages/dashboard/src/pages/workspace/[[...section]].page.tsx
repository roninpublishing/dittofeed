import { Stack } from "@mui/material";
import { getPublisherForWorkspace } from "backend-lib/src/newsletters";
import { GetServerSideProps } from "next";

import DashboardContent from "../../components/dashboardContent";
import WorkspaceDashboard from "../../components/workspace/dashboard";
import { addInitialStateToProps } from "../../lib/addInitialStateToProps";
import { requestContext } from "../../lib/requestContext";
import { PropsWithInitialState } from "../../lib/types";
import { parseWorkspaceRoute, WorkspaceRoute } from "../../lib/workspaceRoutes";

type Props = PropsWithInitialState<{
  publisherId: string | null;
  isPublisher: boolean;
  route: WorkspaceRoute;
}>;

export const getServerSideProps: GetServerSideProps<Props> = requestContext(
  async (context, dfContext) => {
    const route = parseWorkspaceRoute(context.params?.section);
    if (!route) return { notFound: true };
    const publisherId = await getPublisherForWorkspace(dfContext.workspace.id);
    return {
      props: addInitialStateToProps({
        dfContext,
        props: {
          publisherId,
          isPublisher: publisherId === dfContext.workspace.id,
          route,
        },
      }),
    };
  },
);

export default function WorkspacePage({
  publisherId,
  isPublisher,
  route,
}: Props) {
  return (
    <DashboardContent publisherManagement={isPublisher}>
      <Stack
        spacing={2}
        sx={{
          p: { xs: 2, md: 3 },
          width: "100%",
          minWidth: 0,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <WorkspaceDashboard publisherId={publisherId} route={route} />
      </Stack>
    </DashboardContent>
  );
}
