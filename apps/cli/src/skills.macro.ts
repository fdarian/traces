import { embedSkills } from 'effect-cli-skills/embed';

export const skills = () => embedSkills(`${import.meta.dir}/../skills`);
