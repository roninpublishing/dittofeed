import { Stack } from "@mui/material";
import { getPublisherForWorkspace } from "backend-lib/src/newsletters";
import { GetServerSideProps } from "next";

import DashboardContent from "../components/dashboardContent";
import PublicationManagement from "../components/publications/management";
import { addInitialStateToProps } from "../lib/addInitialStateToProps";
import { requestContext } from "../lib/requestContext";
import { PropsWithInitialState } from "../lib/types";

type Props = PropsWithInitialState<{
  publisherId: string | null;
  isPublisher: boolean;
}>;

export const getServerSideProps: GetServerSideProps<Props> = requestContext(
  async (_context, dfContext) => {
    const publisherId = await getPublisherForWorkspace(dfContext.workspace.id);
    return {
      props: addInitialStateToProps({
        dfContext,
        props: {
          publisherId,
          isPublisher: publisherId === dfContext.workspace.id,
        },
      }),
    };
  },
);

export default function WorkspaceDashboard({
  publisherId,
  isPublisher,
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
        <PublicationManagement publisherId={publisherId} />
      </Stack>
    </DashboardContent>
  );
}
