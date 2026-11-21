import { GetServerSideProps } from "next";

// Keep the route reserved, but do not load workspace data or expose an editor.
export const getServerSideProps: GetServerSideProps = async () => ({
  notFound: true,
});

export default function MessageEditor() {
  return null;
}
